import { Command } from '@commander-js/extra-typings';
import { providers, Wallet, constants, Contract } from 'ethers';

const BridgeAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: 'address', name: 'token', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'WithdrawToCollector',
    type: 'event',
  },
  {
    inputs: [{ internalType: 'bytes', name: 'burnProof', type: 'bytes' }],
    name: 'exit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bytes[]', name: 'burnProofs', type: 'bytes[]' }],
    name: 'exit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

export function addCommand(program: Command) {
  program
    .command('polygon-bridge-exit')
    .description('call exit function on mainnet from polygon bridge transaction')
    .argument('<tx_hash>')
    .argument('<bridge>')
    .action(async (tx_hash, bridge) => {
      if (!tx_hash.startsWith('0x') || tx_hash.trim().length != 66) {
        throw new Error(`${tx_hash} doesn't look like a txn hash.`);
      }
      const transferSignature = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const fromCheckAddress = bridge.toLowerCase();

      const l1Provider = new providers.JsonRpcProvider(process.env.RPC_MAINNET);
      const l2Provider = new providers.JsonRpcProvider(process.env.RPC_POLYGON);
      const walletPrivateKey = process.env.PRIVATE_KEY ?? '';
      const l1Wallet = new Wallet(walletPrivateKey, l1Provider);

      console.log('Generating proofs...');
      const receipt = await l2Provider.getTransactionReceipt(tx_hash);
      let index = -1;
      const proofs = [];
      for (const log of receipt.logs) {
        if (log?.topics[0] != transferSignature) {
          continue;
        }
        const from = '0x' + log?.topics[1].slice(-40);
        const to = '0x' + log?.topics[2].slice(-40);

        if (to != constants.AddressZero) {
          continue;
        }

        index++;
        if (from != fromCheckAddress) {
          continue;
        }

        console.log(index);
        const proofResponse = await fetch(
          `https://proof-generator.polygon.technology/api/v1/matic/exit-payload/${tx_hash}?eventSignature=${transferSignature}&tokenIndex=${index}`
        );
        const proofData = await proofResponse.json();
        if (!proofData?.result) {
          continue;
        }

        proofs.push(proofData.result);
      }

      const bridgeContract = new Contract(bridge, BridgeAbi, l1Wallet);
      for (const idx in proofs) {
        console.log('Executing exit function...:', idx);
        const tx = await bridgeContract['exit(bytes)'](proofs[idx]);
        console.log('Transaction sent:', tx.hash);
        console.log('Waiting for transaction to be confirmed...');
        await tx.wait();
      }

      console.log('finished');
    });
}
