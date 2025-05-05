import { existsSync, mkdirSync } from "fs";
import * as fs from "fs/promises";
import path from "path";
import { validateEnvironment } from "@helpers/client";
import type { AgentWalletData } from "@helpers/cdp";
import { TossStatus, type GroupTossName } from "./types";

const { NETWORK_ID } = validateEnvironment(["NETWORK_ID"]);
export const STORAGE_DIRS = {
  WALLET: ".data/wallet_data",
  XMTP: ".data/xmtp",
  TOSS: ".data/tosses",
  GROUP_MAPPING: ".data/tosses/group_mapping"
};

/**
 * Storage service for coin toss data and user wallets
 */
class StorageService {
  private initialized = false;

  constructor() {
    this.initialize();
  }

  /**
   * Initialize storage directories
   */
  public initialize(): void {
    if (this.initialized) return;
    
    Object.values(STORAGE_DIRS).forEach(dir => {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    });

    this.initialized = true;
    console.log("Local file storage initialized");
  }

  /**
   * File operations - save/read/delete
   */
  private async saveToFile(directory: string, identifier: string, data: string): Promise<boolean> {
    const key = `${identifier}-${NETWORK_ID}`;
    try {
      await fs.writeFile(path.join(directory, `${key}.json`), data);
      return true;
    } catch (error) {
      console.error(`Error writing to file ${key}:`, error);
      return false;
    }
  }

  private async readFromFile<T>(directory: string, identifier: string): Promise<T | null> {
    try {
      const key = `${identifier}-${NETWORK_ID}`;
      const data = await fs.readFile(path.join(directory, `${key}.json`), "utf-8");
      return JSON.parse(data) as T;
    } catch (error) {
      if (error instanceof Error && 
          (error.message.includes("ENOENT") || error.message.includes("no such file or directory"))) {
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
   * Toss operations
   */
  public async saveToss(toss: GroupTossName): Promise<void> {
    if (!this.initialized) this.initialize();
    await this.saveToFile(STORAGE_DIRS.TOSS, toss.id, JSON.stringify(toss));
  }

  public async getToss(tossId: string): Promise<GroupTossName | null> {
    if (!this.initialized) this.initialize();
    return this.readFromFile<GroupTossName>(STORAGE_DIRS.TOSS, tossId);
  }

  public async listActiveTosses(): Promise<GroupTossName[]> {
    if (!this.initialized) this.initialize();
    
    try {
      const files = await fs.readdir(STORAGE_DIRS.TOSS);
      const tosses: GroupTossName[] = [];
      
      for (const file of files.filter(f => f.endsWith(".json"))) {
        const tossId = file.replace(`-${NETWORK_ID}.json`, "");
        const toss = await this.getToss(tossId);
        
        if (toss && ![TossStatus.COMPLETED, TossStatus.CANCELLED].includes(toss.status)) {
          tosses.push(toss);
        }
      }
      
      return tosses;
    } catch (error) {
      console.error("Error listing active games:", error);
      return [];
    }
  }

  // updateToss is just an alias for saveToss
  public updateToss = this.saveToss;

  /**
   * Group to Toss mapping operations
   */
  public async saveGroupTossMapping(conversationId: string, tossId: string): Promise<void> {
    if (!this.initialized) this.initialize();
    await this.saveToFile(STORAGE_DIRS.GROUP_MAPPING, conversationId, JSON.stringify({ tossId }));
  }

  public async getGroupTossMapping(conversationId: string): Promise<string | null> {
    if (!this.initialized) this.initialize();
    const mapping = await this.readFromFile<{ tossId: string }>(STORAGE_DIRS.GROUP_MAPPING, conversationId);
    return mapping ? mapping.tossId : null;
  }

  public async removeGroupTossMapping(conversationId: string): Promise<boolean> {
    if (!this.initialized) this.initialize();
    try {
      const key = `${conversationId}-${NETWORK_ID}`;
      return await this.deleteFile(STORAGE_DIRS.GROUP_MAPPING, key);
    } catch (error) {
      console.error(`Error removing group mapping for ${conversationId}:`, error);
      return false;
    }
  }

  /**
   * Wallet operations
   */
  public async saveWallet(inboxId: string, walletData: string): Promise<void> {
    if (!this.initialized) this.initialize();
    await this.saveToFile(STORAGE_DIRS.WALLET, inboxId, walletData);
  }

  public async getWallet(inboxId: string): Promise<AgentWalletData | null> {
    if (!this.initialized) this.initialize();
    return this.readFromFile<AgentWalletData>(STORAGE_DIRS.WALLET, inboxId);
  }

  public async getWalletCount(): Promise<number> {
    try {
      const files = await fs.readdir(STORAGE_DIRS.WALLET);
      return files.filter(file => file.endsWith(".json")).length;
    } catch (error) {
      console.error("Error getting wallet count:", error);
      return 0;
    }
  }

  // Simple accessor
  public getTossStorageDir = () => STORAGE_DIRS.TOSS;
}

// Export a single global instance
export const storage = new StorageService();

