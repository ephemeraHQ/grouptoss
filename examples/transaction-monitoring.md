# Transaction Monitoring System

The grouptoss application now includes automatic blockchain transaction monitoring that can detect payments to toss wallets without requiring users to manually send transaction references.

## How It Works

### 1. Automatic Monitoring Setup
When a toss is created, the system automatically:
- Creates a unique wallet for the toss
- Adds the wallet address to the transaction monitor
- Starts listening for USDC transfers to that address

### 2. Transaction Detection
The `TransactionMonitor` class:
- Polls the blockchain every 30 seconds for new transactions
- Monitors USDC Transfer events using Viem and Base/Base Sepolia networks
- Detects transfers to monitored wallet addresses
- Automatically processes detected transactions

### 3. Option Detection
When a transaction is detected, the system tries to determine the user's choice using:
- Amount encoding (remainder method: adding 1 or 2 to the base amount)
- Metadata from transaction calls (if available)
- Fallback to asking the user for clarification

## Features

### Commands
- `@toss monitor` - Shows transaction monitoring status and monitored wallets
- `@toss status` - Shows toss status including monitoring information
- All existing commands work as before

### Automatic Processing
- No need for users to send transaction references manually
- Faster detection of payments (30-second polling)
- Automatic participant addition when payments are detected
- Graceful handling of unidentified senders

### Monitoring Lifecycle
- Wallets are added to monitoring when tosses are created
- Wallets are removed from monitoring when tosses complete or are cancelled
- Monitoring continues automatically in the background

## Configuration

The system uses the same network configuration as the existing app:
- Base Sepolia (testnet) 
- Base Mainnet (production)
- USDC token transfers only
- Configurable polling interval (default: 30 seconds)

## Benefits

1. **Better UX**: Users don't need to manually send transaction references
2. **Reliability**: Doesn't depend on wallet apps sending references
3. **Real-time**: Faster detection of payments
4. **Automatic**: Works in the background without user intervention
5. **Backward Compatible**: Still supports manual transaction references

## Example Usage

```typescript
// The transaction monitor is automatically initialized in TossManager
const tossManager = new TossManager(walletService, storage);

// When a toss is created, monitoring starts automatically
const toss = await tossManager.createGame("creatorInboxId", "1.0");
// -> Wallet automatically added to monitoring

// Monitor status can be checked
const isActive = tossManager.transactionMonitor.isActive();
const monitoredWallets = tossManager.transactionMonitor.getMonitoredWallets();

// When toss completes, monitoring stops automatically
await tossManager.executeToss(toss.id, "yes");
// -> Wallet automatically removed from monitoring
```

## Technical Details

### TransactionMonitor Class
- Uses Viem's `getLogs()` to query USDC Transfer events
- Maintains last checked block per wallet to avoid re-processing
- Includes retry logic and error handling
- Supports balance auditing for discrepancy detection

### Integration Points
- Integrated into `TossManager` constructor
- Wallet monitoring added in `createGame()`
- Wallet monitoring removed in `executeToss()` and `forceCloseToss()`
- Callback system for processing detected transactions

### Error Handling
- Graceful degradation if monitoring fails
- Fallback to manual transaction references
- User notification for unresolved payments
- Comprehensive logging for debugging 