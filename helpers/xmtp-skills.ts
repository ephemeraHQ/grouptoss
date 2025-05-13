import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { AgentOptions } from "./xmtp-handler";  

export const sendWelcomeMessage = async (
  client: Client,
  conversation: Conversation,
  message: string,
) => {
  await conversation.sync();
  const messages = await conversation.messages();
  const hasSentBefore = messages.some(
    (msg) => msg.senderInboxId.toLowerCase() === client.inboxId.toLowerCase(),
  );
  
  if (!hasSentBefore) {
    await conversation.send(message);
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
  if (options.welcomeMessage && isDm) {
    const sent = await sendWelcomeMessage(
      client,
      conversation,
      options.welcomeMessage,
    );
    if (sent) return true;
  }
  
  if (options.groupWelcomeMessage && !isDm && options.acceptGroups) {
    const sent = await sendWelcomeMessage(
      client,
      conversation,
      options.groupWelcomeMessage,
    );
    if (sent) return true;
  }
  
  return false;
}
  