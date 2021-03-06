import { uuidv4 } from '../utils';
import { ACTION_TYPE, OPERATION_TYPE, STATUS } from './interfaces';
import { Action } from './Action';
import * as ethActions from '../../blockchain/busd/eth';
import * as hmyActions from '../../blockchain/busd/hmy';
import { hmy } from '../../blockchain/hmySdk';
import { createError } from '../../routes/helpers';

export interface IOperationInitParams {
  type: OPERATION_TYPE;
  ethAddress: string;
  oneAddress: string;
  actions: Record<ACTION_TYPE, string>;
  amount: string;
}

export class Operation {
  id: string;
  type: OPERATION_TYPE;
  status: STATUS;
  ethAddress: string;
  oneAddress: string;
  amount: string;
  actions: Action[];

  constructor(params: IOperationInitParams) {
    this.id = uuidv4();
    this.status = STATUS.WAITING;

    this.oneAddress = params.oneAddress;
    this.ethAddress = params.ethAddress;
    this.amount = params.amount;
    this.type = params.type;

    switch (params.type) {
      case OPERATION_TYPE.BUSD_ETH_ONE:
        this.BUSD_ETH_ONE(params);
        break;

      case OPERATION_TYPE.BUSD_ONE_ETH:
        this.BUSD_ONE_ETH(params);
        break;

      default:
        throw createError(500, 'Operation type not found');
    }

    this.startActionsPool();
  }

  BUSD_ETH_ONE = (params: IOperationInitParams) => {
    const approveEthMangerAction = new Action({
      type: ACTION_TYPE.approveEthManger,
      awaitConfirmation: true,
      callFunction: hash => ethActions.getTransactionReceipt(hash),
    });

    const lockTokenAction = new Action({
      type: ACTION_TYPE.lockToken,
      awaitConfirmation: true,
      callFunction: hash => ethActions.getTransactionReceipt(hash),
    });

    const waitingBlockNumberAction = new Action({
      type: ACTION_TYPE.waitingBlockNumber,
      callFunction: () =>
        ethActions.waitingBlockNumber(
          lockTokenAction.payload.blockNumber,
          msg => (waitingBlockNumberAction.message = msg)
        ),
    });

    const mintTokenAction = new Action({
      type: ACTION_TYPE.mintToken,
      callFunction: () => {
        let approvalLog = ethActions.decodeApprovalLog(approveEthMangerAction.payload);
        if (approvalLog.spender != process.env.ETH_MANAGER_CONTRACT) {
          return new Promise(resolve => {
            resolve(null);
          });
        }
        let lockTokenLog = ethActions.decodeLockTokenLog(lockTokenAction.payload);
        if (lockTokenLog.amount != approvalLog.value) {
          return new Promise(resolve => {
            resolve(null);
          });
        }
        return hmyActions.mintToken(
          lockTokenLog.recipient,
          lockTokenLog.amount,
          lockTokenAction.transactionHash
        );
      },
    });

    this.actions = [
      approveEthMangerAction,
      lockTokenAction,
      waitingBlockNumberAction,
      mintTokenAction,
    ];
  };

  BUSD_ONE_ETH = (params: IOperationInitParams) => {
    const approveHmyMangerAction = new Action({
      type: ACTION_TYPE.approveHmyManger,
      awaitConfirmation: true,
      callFunction: hash => hmyActions.getTransactionReceipt(hash),
    });

    const burnTokenAction = new Action({
      type: ACTION_TYPE.burnToken,
      awaitConfirmation: true,
      callFunction: hash => hmyActions.getTransactionReceipt(hash),
    });

    // TODO: unlockToken return success status, but tokens not transfer

    const unlockTokenAction = new Action({
      type: ACTION_TYPE.unlockToken,
      callFunction: () => {
        let approvalLog = hmyActions.decodeApprovalLog(approveHmyMangerAction.payload);
        if (approvalLog.spender.toUpperCase() != process.env.HMY_MANAGER_CONTRACT.toUpperCase()) {
          return new Promise(resolve => {
            resolve(null);
          });
        }
        let burnTokenLog = hmyActions.decodeBurnTokenLog(burnTokenAction.payload);
        if (burnTokenLog.amount != approvalLog.value) {
          return new Promise(resolve => {
            resolve(null);
          });
        }
        return ethActions.unlockToken(
          burnTokenLog.recipient,
          burnTokenLog.amount,
          burnTokenAction.transactionHash
        );
      },
    });

    this.actions = [approveHmyMangerAction, burnTokenAction, unlockTokenAction];
  };

  startActionsPool = async () => {
    let actionIndex = 0;

    // TODO: add mode for continue operation loading from DB
    if (this.actions.some(a => a.status !== STATUS.WAITING)) {
      return;
    }

    this.status = STATUS.IN_PROGRESS;

    while (this.actions[actionIndex]) {
      // TODO: patch operation in DB

      const action = this.actions[actionIndex];

      const res = await action.call();

      if (!res) {
        this.status = STATUS.ERROR;
        return;
      }

      actionIndex++;
    }

    this.status = STATUS.SUCCESS;
  };

  toObject = () => {
    return {
      id: this.id,
      type: this.type,
      status: this.status,
      amount: this.amount,
      ethAddress: this.ethAddress,
      oneAddress: this.oneAddress,
      actions: this.actions.map(a => a.toObject()),
    };
  };
}
