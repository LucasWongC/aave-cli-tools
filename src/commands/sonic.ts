import { Command } from '@commander-js/extra-typings';

import { providers, Wallet, Contract, utils, BigNumber } from 'ethers';

// Ethereum (L1)
const ETH_CONTRACTS = {
  BRIDGE: '0xa1E2481a9CD0Cb0447EeB1cbc26F1b3fff3bec20',
  TOKEN_PAIRS: '0xf2b1510c2709072C88C5b14db90Ec3b6297193e4',
  STATE_ORACLE: '0xB7e8CC3F5FeA12443136f0cc13D81F109B2dEd7f',
};

// Sonic (L2)
const SONIC_CONTRACTS = {
  BRIDGE: '0x9Ef7629F9B930168b76283AdD7120777b3c895b3',
  TOKEN_PAIRS: '0x134E4c207aD5A13549DE1eBF8D43c1f49b00ba94',
  STATE_ORACLE: '0x836664B0c0CB29B7877bCcF94159CC996528F2C3',
};

const STATE_ORACLE_ABI = ['function lastBlockNum() external view returns (uint256)'];

const BRIDGE_ABI = [
  'event Withdrawal(uint256 indexed id, address indexed owner, address token, uint256 amount)',
  'event Deposit(uint256 indexed id, address indexed owner, address token, uint256 amount)',
  'function claim(uint256 id, address token, uint256 amount, bytes calldata proof) external',
];

async function waitForStateUpdate(depositBlockNumber: number, stateOracle: Contract) {
  while (true) {
    const currentBlockNum = await stateOracle.lastBlockNum();
    if (currentBlockNum >= depositBlockNumber) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30000)); // Check every 30 seconds
  }
}

async function generateProof(
  depositId: string,
  provider: providers.JsonRpcProvider,
  bridgeAddress: string,
  slotIndex: number,
  blockNumber: string
) {
  const storageSlot = utils.keccak256(utils.defaultAbiCoder.encode(['uint256', 'uint8'], [depositId, slotIndex]));

  const proof = await provider.send('eth_getProof', [bridgeAddress, [storageSlot], blockNumber]);

  return utils.RLP.encode([utils.RLP.encode(proof.accountProof), utils.RLP.encode(proof.storageProof[0].proof)]);
}

export function addCommand(program: Command) {
  program
    .command('sonic-claim')
    .description('claim bridged token on destination chain')
    .argument('<source_chain_id>')
    .argument('<tx_hash>')
    .argument('<bridge>')
    .action(async (source_chain_id, tx_hash, bridge) => {
      if (!tx_hash.startsWith('0x') || tx_hash.trim().length != 66) {
        throw new Error(`${tx_hash} doesn't look like a txn hash.`);
      }

      const sourceChainId = Number(source_chain_id);
      let srcProvider: providers.JsonRpcProvider;
      let dstProvider: providers.JsonRpcProvider;
      let srcContracts: any;
      let dstContracts: any;
      let slotIndex: number;
      if (sourceChainId == 1) {
        srcProvider = new providers.JsonRpcProvider(process.env.RPC_MAINNET);
        dstProvider = new providers.JsonRpcProvider(process.env.RPC_SONIC);
        srcContracts = ETH_CONTRACTS;
        dstContracts = SONIC_CONTRACTS;
        slotIndex = 7;
      } else if (sourceChainId == 146) {
        srcProvider = new providers.JsonRpcProvider(process.env.RPC_SONIC);
        dstProvider = new providers.JsonRpcProvider(process.env.RPC_MAINNET);
        dstContracts = ETH_CONTRACTS;
        srcContracts = SONIC_CONTRACTS;
        slotIndex = 1;
      } else {
        throw Error('Invalid source chain id');
      }

      const bridgeInterface = new utils.Interface(BRIDGE_ABI);
      const sourceTx = await srcProvider!.getTransactionReceipt(tx_hash);
      const depositBlockNumber = sourceTx.blockNumber;

      const logs = sourceTx.logs.filter((log) => {
        try {
          const parsedLog = bridgeInterface.parseLog(log);
          console.log(parsedLog);

          if (parsedLog?.name != 'Deposit' && parsedLog?.name != 'Withdrawal') {
            return false;
          }

          return true;
        } catch (err) {
          return false;
        }
      });

      if (!logs.length) {
        throw Error("Couldn't find deposit log");
      }

      for (const log of logs) {
        const parsedLog = bridgeInterface.parseLog(log);
        const depositId = parsedLog.args.id;
        const token = parsedLog.args.token;
        const amount = parsedLog.args.amount;

        console.log('Waiting for state oracle update...');
        const stateOracle = new Contract(dstContracts.STATE_ORACLE, STATE_ORACLE_ABI, dstProvider);
        await waitForStateUpdate(depositBlockNumber, stateOracle);

        console.log('Generating proof...');
        const lastBlockNum: BigNumber = await stateOracle.lastBlockNum();
        const lastBlockNumWithoutLeadingZeros = '0x' + lastBlockNum.toHexString().slice(2).replace(/^0+/, '');
        console.log('Last block number:', lastBlockNumWithoutLeadingZeros);
        const proof = await generateProof(
          depositId,
          srcProvider,
          srcContracts.BRIDGE,
          slotIndex,
          lastBlockNumWithoutLeadingZeros
        );

        console.log('Claiming tokens with proof');
        const walletPrivateKey = process.env.PRIVATE_KEY ?? '';
        const wallet = new Wallet(walletPrivateKey, dstProvider);
        const dstBridgeContract = new Contract(bridge, BRIDGE_ABI, wallet);

        const tx = await dstBridgeContract.claim(depositId, token, amount, proof);
        console.log('Claim transaction was sent:', tx.hash);

        await tx.wait();
        console.log('Token claiming succeed!');
      }
    });
}
