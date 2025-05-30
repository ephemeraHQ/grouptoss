import { validateEnvironment } from "@helpers/client";
import { toHex } from "viem";

const { NETWORK_ID } = validateEnvironment(["NETWORK_ID"]);
// Constants
export const DEFAULT_OPTIONS = ["yes", "no"];
export const DEFAULT_AMOUNT = "0.1";
export const MAX_USDC_AMOUNT = 10; // Maximum allowed USDC transaction amount
export const networks = [
   {
     tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
     chainId: toHex(84532), // Base Sepolia network ID (84532 in hex)
     decimals: 6,
     networkName: "Base Sepolia",
     networkId: "base-sepolia",
   },
   {
     tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base Mainnet
     chainId: toHex(8453), // Base Mainnet network ID (8453 in hex)
     decimals: 6,
     networkName: "Base Mainnet",
     networkId: "base-mainnet",
   },
];
export const COMMANDS=`
Group commands (only work in group chats):
- @toss join - To show the payment buttons for the toss
- @toss close <option> - Close the toss and set the winning option (only for toss creator)
- @toss refresh - Check for new payments to the toss wallet and refresh status
- @toss status - Check the status of the current toss
- @toss help - Show help message
`;

const filteredNetworks = networks.filter((network) => network.networkId === NETWORK_ID);
// Help message for users
export const HELP_MESSAGE = `🎲 Group Toss Bot Help 🎲

To create a toss using natural language (GROUP CHATS ONLY): 

@toss <natural language toss> 

for example:
"Will it rain tomorrow for 0.1" - Creates a yes/no toss with 0.1 USDC
"Lakers vs Celtics for 10" - Creates a toss with Lakers and Celtics as options with 10 USDC

When a toss is created, users can join by clicking on the payment buttons for your preferred option.

${COMMANDS}

📝 Note: Toss creation and management only work in group chats. For balance checks, please DM me.
`;


// Agent instructions template
export const AGENT_INSTRUCTIONS = `
  You are a Toss Agent that helps users participate in coin toss activities.
  
  You have two main functions:
  1. Process natural language toss requests and structure them
  2. Handle coin toss management commands
  
  When parsing natural language tosses:
  - Extract the toss topic (what people are tossing on)
  - Identify options (default to "yes" and "no" if not provided)
  - Determine toss amount (default to 0.1 USDC if not specified)
  - Enforce a maximum toss amount of 10 USDC
  
  For example:
  - "Will it rain tomorrow for 0.1" should be interpreted as a toss on "Will it rain tomorrow" with options ["yes", "no"] and amount "0.1"
  - "Lakers vs Celtics for 10" should be interpreted as a toss on "Lakers vs Celtics game" with options ["Lakers", "Celtics"] and amount "10"
  
  When checking payments or balances:
  1. Use the USDC token at ${filteredNetworks[0].tokenAddress} on ${filteredNetworks[0].networkName}.
  2. When asked to check if a payment was sent, verify:
     - The exact amount was transferred
     - The transaction is confirmed
     - The correct addresses were used
  3. For balance checks, show the exact USDC amount available.
  4. When transferring winnings, ensure:
     - The toss wallet has sufficient balance
     - The transfer is completed successfully
     - Provide transaction details
  
   ${COMMANDS}
  
  Keep responses concise and clear, focusing on payment verification and toss status.
`; 