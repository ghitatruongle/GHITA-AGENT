// Pub/sub messaging system for isolated sub-agent coordination

import type { ChannelMessage, ChannelSubscription } from './types.js';

// Helpers

function generateMsgId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateSubId(): string {
  return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// AgentChannel

export class AgentChannel {
  /** All active subscriptions indexed by topic */
  private readonly subsByTopic = new Map<string, ChannelSubscription[]>();
  /** All subscriptions indexed by agent id */
  private readonly subsByAgent = new Map<string, ChannelSubscription[]>();
  /** Message history for replay (bounded) */
  private readonly history: ChannelMessage[] = [];
  /** Max messages to retain for late-joining agents */
  private readonly maxHistory: number;
  /** Pending messages for agents not yet subscribed */
  private readonly deadLetterQueue = new Map<string, ChannelMessage[]>();

  constructor(options: { maxHistory?: number } = {}) {
    this.maxHistory = options.maxHistory ?? 200;
  }

  // Subscription Management

  /**
   * Subscribe an agent to a topic.
   * Returns a subscription id that can be used to unsubscribe.
   */
  subscribe(
    agentId: string,
    topic: string,
    handler: (message: ChannelMessage) => void | Promise<void>,
  ): string {
    const id = generateSubId();
    const subscription: ChannelSubscription = { id, agentId, topic, handler };

    // Index by topic
    const topicSubs = this.subsByTopic.get(topic) ?? [];
    topicSubs.push(subscription);
    this.subsByTopic.set(topic, topicSubs);

    // Index by agent
    const agentSubs = this.subsByAgent.get(agentId) ?? [];
    agentSubs.push(subscription);
    this.subsByAgent.set(agentId, agentSubs);

    // Deliver any dead-letter messages for this topic
    this.flushDeadLetter(agentId, topic, handler);

    return id;
  }

  /**
   * Unsubscribe by subscription id.
   */
  unsubscribe(subscriptionId: string): boolean {
    for (const [topic, subs] of this.subsByTopic) {
      const idx = subs.findIndex((s) => s.id === subscriptionId);
      if (idx !== -1) {
        const removed = subs.splice(idx, 1);
        if (subs.length === 0) this.subsByTopic.delete(topic);

        // Also remove from agent index
        const sub = removed[0];
        if (sub) {
          const agentSubs = this.subsByAgent.get(sub.agentId);
          if (agentSubs) {
            const aIdx = agentSubs.findIndex((s) => s.id === subscriptionId);
            if (aIdx !== -1) agentSubs.splice(aIdx, 1);
            if (agentSubs.length === 0) this.subsByAgent.delete(sub.agentId);
          }
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Remove all subscriptions for a given agent (cleanup on agent destroy).
   */
  removeAgent(agentId: string): number {
    const agentSubs = this.subsByAgent.get(agentId) ?? [];
    let count = 0;
    for (const sub of agentSubs) {
      if (this.unsubscribe(sub.id)) count++;
    }
    this.subsByAgent.delete(agentId);
    return count;
  }

  // Messaging

  /**
   * Publish a message to a topic. Delivered to all subscribers of that topic.
   * Returns the message id.
   */
  async publish(
    from: string,
    topic: string,
    payload: unknown,
    options?: { replyTo?: string },
  ): Promise<string> {
    const msg: ChannelMessage = {
      id: generateMsgId(),
      from,
      to: '*',
      topic,
      payload,
      timestamp: Date.now(),
      replyTo: options?.replyTo,
    };

    this.addToHistory(msg);

    const subs = this.subsByTopic.get(topic) ?? [];
    const deliveryPromises: Promise<void>[] = [];

    for (const sub of subs) {
      // Don't deliver to sender
      if (sub.agentId === from) continue;

      try {
        const result = sub.handler(msg);
        if (result instanceof Promise) {
          deliveryPromises.push(
            result.catch(() => {
              /* swallow handler errors */
            }),
          );
        }
      } catch {
        // Swallow synchronous handler errors to avoid breaking delivery
      }
    }

    // If no subscribers, queue to dead-letter for future delivery
    if (subs.length === 0) {
      this.addDeadLetter(topic, msg);
    }

    await Promise.all(deliveryPromises);
    return msg.id;
  }

  /**
   * Send a direct message to a specific agent (via topic 'dm').
   */
  async send(
    from: string,
    to: string,
    payload: unknown,
    options?: { replyTo?: string },
  ): Promise<string> {
    const msg: ChannelMessage = {
      id: generateMsgId(),
      from,
      to,
      topic: `dm:${to}`,
      payload,
      timestamp: Date.now(),
      replyTo: options?.replyTo,
    };

    this.addToHistory(msg);

    const subs = this.subsByTopic.get(`dm:${to}`) ?? [];
    if (subs.length === 0) {
      this.addDeadLetter(`dm:${to}`, msg);
      return msg.id;
    }

    for (const sub of subs) {
      try {
        const result = sub.handler(msg);
        if (result instanceof Promise) await result;
      } catch {
        // Swallow handler errors
      }
    }

    return msg.id;
  }

  /**
   * Request-response pattern: publish and wait for a reply.
   */
  async request(
    from: string,
    topic: string,
    payload: unknown,
    timeoutMs = 10_000,
  ): Promise<ChannelMessage | null> {
    const msgId = await this.publish(from, topic, payload);

    return new Promise<ChannelMessage | null>((resolve) => {
      // `settled` để callback reply đến sớm không bị coi là chưa xong: trước đây
      // reply tới trước lúc gán `timer` thì `clearTimeout(null)` là no-op, nên
      // sau khi `request()` ĐÃ trả về thành công vẫn còn timer 30s treo.
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let replySubId: string | null = null;

      const finish = (value: ChannelMessage | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (replySubId) this.unsubscribe(replySubId);
        resolve(value);
      };

      // Hẹn giờ TRƯỚC khi subscribe: subscribe() có thể đồng bộ xả dead-letter
      // (reply tới sớm nằm chờ ở đó) và gọi finish() ngay bên trong nó. Nếu
      // gán timer sau subscribe thì timer sinh ra SAU finish sẽ không bao giờ
      // được xoá (giữ event loop sống thêm timeoutMs), và subscription reply
      // bị rò rỉ vĩnh viễn vì finish thấy replySubId === null.
      timer = setTimeout(() => finish(null), timeoutMs);

      // Subscribe to replies on this message
      replySubId = this.subscribe(from, `reply:${msgId}`, (reply) => {
        finish(reply);
      });

      // finish() đã chạy trong lúc subscribe() xả dead-letter: replySubId còn
      // null lúc đó nên phải tự huỷ ở đây.
      if (settled && replySubId) this.unsubscribe(replySubId);
    });
  }

  /**
   * Reply to a specific message (publishes to reply:<originalMsgId> topic).
   */
  async reply(from: string, originalMessageId: string, payload: unknown): Promise<string> {
    return this.publish(from, `reply:${originalMessageId}`, payload);
  }

  // Query & Inspection

  /** Get all messages in history, optionally filtered by topic */
  getHistory(topic?: string): ChannelMessage[] {
    if (topic) return this.history.filter((m) => m.topic === topic);
    return [...this.history];
  }

  /** Get all messages sent by a specific agent */
  getMessagesFrom(agentId: string): ChannelMessage[] {
    return this.history.filter((m) => m.from === agentId);
  }

  /** Get all topics with active subscribers */
  getActiveTopics(): string[] {
    return [...this.subsByTopic.keys()];
  }

  /** Get subscriber count for a topic */
  getSubscriberCount(topic: string): number {
    return (this.subsByTopic.get(topic) ?? []).length;
  }

  /** Get total number of active subscriptions */
  get totalSubscriptions(): number {
    let count = 0;
    for (const subs of this.subsByTopic.values()) count += subs.length;
    return count;
  }

  // Private Helpers

  private addToHistory(msg: ChannelMessage): void {
    this.history.push(msg);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  private addDeadLetter(topic: string, msg: ChannelMessage): void {
    const queue = this.deadLetterQueue.get(topic) ?? [];
    queue.push(msg);
    // Limit dead-letter queue size
    if (queue.length > 50) queue.shift();
    this.deadLetterQueue.set(topic, queue);
  }

  private flushDeadLetter(
    agentId: string,
    topic: string,
    handler: (msg: ChannelMessage) => void | Promise<void>,
  ): void {
    const queue = this.deadLetterQueue.get(topic);
    if (!queue || queue.length === 0) return;

    for (const msg of queue) {
      // Only deliver messages not sent by the subscribing agent
      if (msg.from !== agentId) {
        try {
          const result = handler(msg);
          if (result instanceof Promise) {
            result.catch(() => {
              /* swallow */
            });
          }
        } catch {
          // Swallow handler errors during replay
        }
      }
    }

    this.deadLetterQueue.delete(topic);
  }
}
