import { Client, Conversation, DecodedMessage, Group } from "@xmtp/node-sdk";
import { env } from "process";
import { AgentOptions } from "./xmtp-handler";

export const sendWelcomeMessage = async (
    client: Client,
    conversation: Conversation,
    welcomeMessage: string,
  ) => {
    // Get all messages from this conversation
    await conversation.sync();
    const messages = await conversation.messages();
    // Check if we have sent any messages in this conversation before
    const sentMessagesBefore = messages.filter(
      (msg) => msg.senderInboxId.toLowerCase() === client.inboxId.toLowerCase(),
    );
    // If we haven't sent any messages before, send a welcome message and skip validation for this message
    if (sentMessagesBefore.length === 0) {
      console.log(`Sending welcome message`);
      await conversation.send(welcomeMessage);
      return true;
    }
    return false;
  };
  
  /**
   * Send a welcome message to a group only if this is the first time the bot is in the group
   * @param client - The XMTP client
   * @param group - The group conversation
   * @param welcomeMessage - The welcome message to send
   * @returns True if a welcome message was sent, false otherwise
   */
  export const sendGroupWelcomeMessage = async (
    client: Client,
    group: Group,
    groupWelcomeMessage: string,
  ) => {
    // Get all messages from this group
    await group.sync();
    const messages = await group.messages();
    
    // Check if we have sent any messages in this group before
    const sentMessagesBefore = messages.filter(
      (msg) => msg.senderInboxId.toLowerCase() === client.inboxId.toLowerCase(),
    );
    
    // If we haven't sent any messages before, send a welcome message
    if (sentMessagesBefore.length === 0) {
      console.log(`Sending group welcome message to ${group.name}`);
      await group.send(groupWelcomeMessage);
      return true;
    }
    return false;
  };
  
  export const preMessageHandler = async (
    client: Client,
    conversation: Conversation,
    message: DecodedMessage,
    isDm: boolean,
    options: AgentOptions,
  ) => {
    // Handle welcome messages for DMs
    if (options.welcomeMessage && isDm) {
      const sent = await sendWelcomeMessage(
        client,
        conversation,
        options.welcomeMessage,
      );
      if (sent) {
        console.log(`[${env}] Welcome message sent, skipping`);
        return true;
      }
    }
    // Handle welcome messages for Groups
    if (options.groupWelcomeMessage && !isDm && options.acceptGroups) {
      const sent = await sendGroupWelcomeMessage(
        client,
        conversation as Group,
        options.groupWelcomeMessage,
      );
      if (sent) {
        console.log(`[${env}] Group welcome message sent, skipping`);
        return true;
      }
    }
    return false;
  }
  