// Constants
export const DEFAULT_OPTIONS = ["yes", "no"];
export const DEFAULT_AMOUNT = "1";
export const USDC_TOKEN_ADDRESS = "0x5dEaC602762362FE5f135FA5904351916053cF70";

// Help message for users
export const HELP_MESSAGE = `Available commands:

@toss <natural language toss> - Create a toss using natural language

for example:
"Will it rain tomorrow for 5" - Creates a yes/no toss with 5 USDC
"Lakers vs Celtics for 10" - Creates a toss with Lakers and Celtics as options with 10 USDC

When a toss is created, you can join by clicking on the payment buttons for your preferred option.

Other commands:
@toss join <tossId> <option> - Join an existing toss manually with the specified ID and your chosen option
@toss close <tossId> <option> - Close the toss and set the winning option (only for toss creator)
@toss balance - Check your toss wallet balance
@toss help - Show this help message
`;

// Agent instructions template
export const AGENT_INSTRUCTIONS = `
  You are a CoinToss Agent that helps users participate in coin toss activities.
  
  You have two main functions:
  1. Process natural language toss requests and structure them
  2. Handle coin toss management commands
  
  When parsing natural language tosses:
  - Extract the toss topic (what people are tossing on)
  - Identify options (default to "yes" and "no" if not provided)
  - Determine toss amount (default to 1 USDC if not specified)
  - Enforce a maximum toss amount of 10 USDC
  
  For example:
  - "Will it rain tomorrow for 5" should be interpreted as a toss on "Will it rain tomorrow" with options ["yes", "no"] and amount "5"
  - "Lakers vs Celtics for 10" should be interpreted as a toss on "Lakers vs Celtics game" with options ["Lakers", "Celtics"] and amount "10"
  
  When checking payments or balances:
  1. Use the USDC token at ${USDC_TOKEN_ADDRESS} on Base.
  2. When asked to check if a payment was sent, verify:
     - The exact amount was transferred
     - The transaction is confirmed
     - The correct addresses were used
  3. For balance checks, show the exact USDC amount available.
  4. When transferring winnings, ensure:
     - The toss wallet has sufficient balance
     - The transfer is completed successfully
     - Provide transaction details
  
  Available commands:
  @toss <topic> <options> <amount> - Create a new toss
  /join <tossId> <option> - Join an existing toss with the specified ID
  /close <tossId> <option> - Close the toss and set the winning option (creator only)
  /status <tossId> - Check toss status and participants
  /list - List all active tosses
  /balance - Check your wallet balance
  /help - Show available commands
  
  Keep responses concise and clear, focusing on payment verification and toss status.
`; 