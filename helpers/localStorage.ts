import { existsSync, mkdirSync } from "fs";
import * as fs from "fs/promises";
import path from "path";
import { validateEnvironment } from "./client";
import type { WalletInfo, WalletStorage } from "./walletService";

const { NETWORK_ID } = validateEnvironment(["NETWORK_ID"]);
export const STORAGE_DIRS = {
  WALLET: ".data/wallet_data",
  XMTP: ".data/xmtp",
};

/**
 * Generic file-based storage service
 */
export class FileStorage implements WalletStorage {
  private initialized = false;

  constructor(private baseDirs = STORAGE_DIRS) {
    this.initialize();
  }

  /**
   * Initialize storage directories
   */
  public initialize(): void {
    if (this.initialized) return;

    Object.values(this.baseDirs).forEach((dir) => {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    });

    this.initialized = true;
  }

  /**
   * File operations - save/read/delete
   */
  private async saveToFile(
    directory: string,
    identifier: string,
    data: string,
  ): Promise<boolean> {
    const key = `${identifier}-${NETWORK_ID}`;
    try {
      await fs.writeFile(path.join(directory, `${key}.json`), data);
      return true;
    } catch (error) {
      console.error(`Error writing to file ${key}:`, error);
      return false;
    }
  }

  private async readFromFile<T>(
    directory: string,
    identifier: string,
  ): Promise<T | null> {
    try {
      const key = `${identifier}-${NETWORK_ID}`;
      const data = await fs.readFile(
        path.join(directory, `${key}.json`),
        "utf-8",
      );
      return JSON.parse(data) as T;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("ENOENT") ||
          error.message.includes("no such file or directory"))
      ) {
        return null;
      }
      throw error;
    }
  }

  public async deleteFile(directory: string, key: string): Promise<boolean> {
    try {
      await fs.unlink(path.join(directory, `${key}.json`));
      return true;
    } catch (error) {
      console.error(`Error deleting file ${key}:`, error);
      return false;
    }
  }

  /**
   * Generic data operations
   */
  public async saveData(
    category: string,
    id: string,
    data: unknown,
  ): Promise<boolean> {
    if (!this.initialized) this.initialize();

    // Make sure the directory exists
    const directory = path.join(".data", category);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

    return await this.saveToFile(directory, id, JSON.stringify(data));
  }

  public async getData<T>(category: string, id: string): Promise<T | null> {
    if (!this.initialized) this.initialize();

    const directory = path.join(".data", category);
    return this.readFromFile<T>(directory, id);
  }

  public async listData<T>(category: string): Promise<T[]> {
    if (!this.initialized) this.initialize();

    try {
      const directory = path.join(".data", category);
      if (!existsSync(directory)) return [];

      const files = await fs.readdir(directory);
      const items: T[] = [];

      for (const file of files.filter((f) => f.endsWith(".json"))) {
        const id = file.replace(`-${NETWORK_ID}.json`, "");
        const data = await this.getData<T>(category, id);
        if (data) items.push(data);
      }

      return items;
    } catch (error) {
      console.error(`Error listing data in ${category}:`, error);
      return [];
    }
  }

  public async deleteData(category: string, id: string): Promise<boolean> {
    if (!this.initialized) this.initialize();

    try {
      const directory = path.join(".data", category);
      const key = `${id}-${NETWORK_ID}`;
      return await this.deleteFile(directory, key);
    } catch (error) {
      console.error(`Error deleting data ${id} from ${category}:`, error);
      return false;
    }
  }

  /**
   * Wallet Storage implementation
   */
  public async saveWallet(userId: string, walletData: string): Promise<void> {
    if (!this.initialized) this.initialize();
    await this.saveToFile(this.baseDirs.WALLET, userId, walletData);
  }

  public async getWallet(userId: string): Promise<WalletInfo | null> {
    if (!this.initialized) this.initialize();
    return this.readFromFile(this.baseDirs.WALLET, userId);
  }

  public async getWalletByAddress(address: string): Promise<WalletInfo | null> {
    if (!this.initialized) this.initialize();
    try {
      const directory = this.baseDirs.WALLET;
      if (!existsSync(directory)) return null;

      const files = await fs.readdir(directory);

      for (const file of files.filter((f) => f.endsWith(".json"))) {
        try {
          const data = await fs.readFile(path.join(directory, file), "utf-8");
          const walletData = JSON.parse(data) as WalletInfo;

          // Check if this wallet has the target address
          if (walletData.address.toLowerCase() === address.toLowerCase()) {
            return walletData;
          }
        } catch (err) {
          console.error(`Error parsing wallet data from ${file}:`, err);
          // Skip files with parsing errors
          continue;
        }
      }

      return null;
    } catch (error) {
      console.error(`Error finding wallet by address ${address}:`, error);
      return null;
    }
  }

  public async getWalletCount(): Promise<number> {
    try {
      const files = await fs.readdir(this.baseDirs.WALLET);
      return files.filter((file) => file.endsWith(".json")).length;
    } catch (error) {
      console.error("Error getting wallet count:", error);
      return 0;
    }
  }
}

// Export a single global instance
export const storage = new FileStorage();
