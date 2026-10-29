import { messagingApi } from '@line/bot-sdk';
import { config } from '../config.js';

export type TextMessage = messagingApi.TextMessage;

/** The subset of MessagingApiClient the app uses; tests pass a fake. */
export interface LineApi {
  replyMessage(req: { replyToken: string; messages: TextMessage[] }): Promise<unknown>;
  pushMessage(req: { to: string; messages: TextMessage[] }): Promise<unknown>;
  showLoadingAnimation(req: { chatId: string; loadingSeconds?: number }): Promise<unknown>;
}

export function createLineClient(
  token: string = config.LINE_CHANNEL_ACCESS_TOKEN,
): messagingApi.MessagingApiClient {
  return new messagingApi.MessagingApiClient({ channelAccessToken: token });
}
