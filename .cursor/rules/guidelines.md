# Standalone XMTP Agent Guidelines

This guide provides instructions for creating a standalone XMTP agent.

## Project Structure

A basic XMTP agent should have the following structure:

```
your-agent-name/
├── src/
│   ├── index.ts       # Main entry point
│   └── helper.ts      # Helper functions
├── .env               # Environment variables
├── package.json       # Dependencies and scripts
├── tsconfig.json      # TypeScript configuration
└── README.md          # Documentation
```

## Configuration Files

### package.json

Your package.json should include these essential configurations:

```json
{
  "name": "your-agent-name",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "tsx src/index.ts",
    "dev": "tsx --watch src/index.ts",
    "gen:keys": "tsx scripts/generateKeys.ts"
  },
  "dependencies": {
    "@xmtp/node-sdk": "^2.0.2",
    "uint8arrays": "^5.1.0",
    "viem": "^2.22.17"
  },
  "devDependencies": {
    "@types/node": "^20.14.2",
    "dotenv": "^16.4.5",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3"
  },
  "engines": {
    "node": ">=20"
  }
}
```

Key points:

- Use `"type": "module"` for ES modules support
- Include `tsx` for TypeScript execution
- Specify Node.js >= 20 requirement
- Default to `yarn` as the package manager

### tsconfig.json

Use this TypeScript configuration for your project:

```json
{
  "include": ["src/**/*"],
  "compilerOptions": {
    "outDir": "./dist",
    "esModuleInterop": true,
    "declaration": true,
    "declarationMap": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": false,
    "lib": ["ESNext"],
    "module": "ESNext",
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "strict": true,
    "target": "ESNext"
  }
}
```

### Environment Variables

Create a `.env` file with these variables:

```
# Network: local, dev, or production
XMTP_ENV=dev

# Private keys (generate with a script or use existing)
WALLET_KEY=your_private_key_here
ENCRYPTION_KEY=your_encryption_key_here
```

## Key Components

### Helper Functions (helper.ts)

The helper.ts file should contain utility functions for working with XMTP:

```typescript
import { getRandomValues } from "node:crypto";
import { IdentifierKind, type Signer } from "@xmtp/node-sdk";
import { fromString, toString } from "uint8arrays";
import { createWalletClient, http, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

interface User {
  key: `0x${string}`;
  account: ReturnType<typeof privateKeyToAccount>;
  wallet: ReturnType<typeof createWalletClient>;
}

export const createUser = (key: string): User => {
  const account = privateKeyToAccount(key as `0x${string}`);
  return {
    key: key as `0x${string}`,
    account,
    wallet: createWalletClient({
      account,
      chain: sepolia,
      transport: http(),
    }),
  };
};

export const createSigner = (key: string): Signer => {
  const sanitizedKey = key.startsWith("0x") ? key : `0x${key}`;
  const user = createUser(sanitizedKey);
  return {
    type: "EOA",
    getIdentifier: () => ({
      identifierKind: IdentifierKind.Ethereum,
      identifier: user.account.address.toLowerCase(),
    }),
    signMessage: async (message: string) => {
      const signature = await user.wallet.signMessage({
        message,
        account: user.account,
      });
      return toBytes(signature);
    },
  };
};

// Generate a random encryption key
export const generateEncryptionKeyHex = () => {
  const uint8Array = getRandomValues(new Uint8Array(32));
  return toString(uint8Array, "hex");
};

// Get encryption key from hex string
export const getEncryptionKeyFromHex = (hex: string) => {
  return fromString(hex, "hex");
};
```

### General XMTP Agent Structure (index.ts)

Your agent's main file should follow this general structure:

```typescript
import "dotenv/config";
import { Client, type XmtpEnv } from "@xmtp/node-sdk";
import { createSigner, getEncryptionKeyFromHex } from "./helper";

const { WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV } = process.env;

if (!WALLET_KEY) {
  throw new Error("WALLET_KEY must be set");
}

if (!ENCRYPTION_KEY) {
  throw new Error("ENCRYPTION_KEY must be set");
}

const signer = createSigner(WALLET_KEY);
const dbEncryptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);

const env: XmtpEnv = (XMTP_ENV as XmtpEnv) || "dev";

async function main() {
  console.log(`Creating client on the '${env}' network...`);

  // Create client without specifying dbPath
  const client = await Client.create(signer, {
    dbEncryptionKey,
    env,
  });

  console.log("Syncing conversations...");
  await client.conversations.sync();

  const identifier = await signer.getIdentifier();
  const address = identifier.identifier;

  console.log(`Agent initialized on ${address}`);

  console.log("Waiting for messages...");
  const stream = client.conversations.streamAllMessages();

  for await (const message of await stream) {
    // Skip messages from self or non-text messages
    if (
      message?.senderInboxId.toLowerCase() === client.inboxId.toLowerCase() ||
      message?.contentType?.typeId !== "text"
    ) {
      continue;
    }

    console.log(
      `Received message: ${message.content as string} by ${
        message.senderInboxId
      }`,
    );

    const conversation = await client.conversations.getConversationById(
      message.conversationId,
    );

    if (!conversation) {
      console.log("Unable to find conversation, skipping");
      continue;
    }

    // Process message and send response
    // Add your custom logic here

    console.log("Waiting for messages...");
  }
}

main().catch(console.error);
```

### Generating keys

```tsx
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateEncryptionKeyHex } from "@helpers/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Check Node.js version
const nodeVersion = process.versions.node;
const [major] = nodeVersion.split(".").map(Number);
if (major < 20) {
  console.error("Error: Node.js version 20 or higher is required");
  process.exit(1);
}

console.log("Generating keys for example...");

const walletKey = generatePrivateKey();
const account = privateKeyToAccount(walletKey);
const encryptionKeyHex = generateEncryptionKeyHex();
const publicKey = account.address;

// Get the current working directory (should be the example directory)
const exampleDir = process.cwd();
const exampleName = exampleDir.split("/").pop() || "example";
const filePath = join(exampleDir, ".env");

console.log(`Creating .env file in: ${exampleDir}`);

// Read existing .env file if it exists
let existingEnv = "";
try {
  existingEnv = await readFile(filePath, "utf-8");
  console.log("Found existing .env file");
} catch {
  // File doesn't exist, that's fine
  console.log("No existing .env file found, creating new one");
}

// Check if XMTP_ENV is already set
const xmtpEnvExists = existingEnv.includes("XMTP_ENV=");

const envContent = `# XMTP keys for ${exampleName}
WALLET_KEY=${walletKey}
ENCRYPTION_KEY=${encryptionKeyHex}
${!xmtpEnvExists ? "XMTP_ENV=dev\n" : ""}# public key is ${publicKey}
`;

// Write the .env file to the example directory
await writeFile(filePath, envContent, { flag: "a" });
console.log(`Keys written to ${filePath}`);
console.log(`Public key: ${publicKey}`);
```

### Database Persistence (Optional)

If you need to persist messages across restarts, you can configure a database
path:

```typescript
import fs from "fs";

// Database path configuration
const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".data/xmtp";
// Ensure the volume path directory exists
fs.mkdirSync(volumePath, { recursive: true });

const identifier = await signer.getIdentifier();
const address = identifier.identifier;
const dbPath = `${volumePath}/${address}-${env}`;

// Then pass dbPath to the client options
const client = await Client.create(signer, {
  dbEncryptionKey,
  env,
  dbPath,
});
```

## Running Your Agent

To run your agent locally:

```bash
# Install dependencies
yarn install

# Run in development mode
yarn dev
```

When successfully running, you'll see output like:

```bash
Creating client on the 'dev' network...
Syncing conversations...
Agent initialized on 0xYourAddress
Waiting for messages...
```

## Troubleshooting

Common issues and their solutions:

1. **Missing Environment Variables**: Ensure WALLET_KEY and ENCRYPTION_KEY are
   set
2. **Database Errors**: Check file permissions in your data directory
3. **Network Connection Issues**: Verify you're using the correct XMTP_ENV
   setting
