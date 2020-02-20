import Metadata from './integration/metadata';
import EventAttiv from './integration/eventAttiv';
import Attivlogger from '../logging/logger';
import messages from '../messages/message';
import IStoreBase from './integration/IStoreBase';
import * as AWS from 'aws-sdk';
import * as bluebird from 'bluebird';

export default class StoreSQS implements IStoreBase {
  private subscribes: Array<EventAttiv> = [];

  private UrlChaves = [];

  private SQS: any;

  private WaitTimeSeconds = 20;

  constructor(subscribes: Array<EventAttiv>) {
    this.subscribes = subscribes;
  }

  init(serverless = false) {
    if (serverless) {
      AWS.config.credentials = new AWS.Credentials(
        process.env.AWS_ACCESS_KEY_ID,
        process.env.AWS_SECRET_ACCESS_KEY,
        null,
      );
    }
    AWS.config.update({ region: process.env.AWS_REGION });
    this.SQS = new AWS.SQS({ apiVersion: '2012-11-05' });

    bluebird.promisifyAll(this.SQS, { suffix: 'Promise' });

    this.subscribes.forEach(subscribe => {
      this.addListener(subscribe.listener, subscribe.name);
    });
  }

  async send(nameHandler: string, metadata: Metadata) {
    try {
      let queueUrl = await this.getQueueUrl(nameHandler);

      if (!queueUrl) {
        await this.createQueue(nameHandler);
        queueUrl = await this.getQueueUrl(nameHandler);
      }

      let params;
      if (this.isFifoQueue(nameHandler)) {
        const messageDeduplicationId = String(Math.random());
        params = {
          MessageBody: JSON.stringify(metadata),
          QueueUrl: queueUrl,
          MessageGroupId: '1',
          MessageDeduplicationId: messageDeduplicationId,
        };
      } else {
        params = {
          MessageBody: JSON.stringify(metadata),
          QueueUrl: queueUrl,
        };
      }

      Attivlogger.info(`${messages.SQS.MESSAGE_SEND}: ${nameHandler}`);
      return this.SQS.sendMessagePromise(params);
    } catch (ex) {
      Attivlogger.error(`${messages.SQS.MESSAGE_ERROR_SEND}: ${nameHandler}`);
      throw ex;
    }
  }

  getQueueUrl(nameHandler: string): Promise<string> {
    if (!this.SQS) throw new Error(`${messages.SQS.MESSAGE_ERROR_INIT}`);
    if (!nameHandler) {
      return null;
    } else if (!this.UrlChaves[nameHandler]) {
      const params = {
        QueueName: nameHandler,
      };
      return this.SQS.getQueueUrlPromise(params)
        .then(data => {
          this.UrlChaves[nameHandler] = data.QueueUrl;
          return this.UrlChaves[nameHandler];
        })
        .catch(error => {
          Attivlogger.error(`${messages.SQS.MESSAGE_ERROR_GETURL}: ${nameHandler}`);
          return null;
        });
    }

    return Promise.resolve(this.UrlChaves[nameHandler]);
  }

  async createQueue(nameHandler: string): Promise<string> {
    try {
      let queueUrl = await this.getQueueUrl(nameHandler);
      if (queueUrl) {
        return Promise.resolve(queueUrl);
      }

      let attributes;
      if (this.isFifoQueue(nameHandler)) {
        attributes = {
          ReceiveMessageWaitTimeSeconds: this.WaitTimeSeconds.toString(),
          FifoQueue: 'true',
          VisibilityTimeout: '43200',
        };
      } else {
        attributes = {
          ReceiveMessageWaitTimeSeconds: this.WaitTimeSeconds.toString(),
          VisibilityTimeout: '43200',
        };
      }

      const params = {
        QueueName: nameHandler,
        Attributes: attributes,
      };

      queueUrl = this.SQS.createQueuePromise(params);

      Attivlogger.info(`${messages.SQS.MESSAGE_CREATE_QUEUE}: ${nameHandler}`);

      return queueUrl;
    } catch (ex) {
      Attivlogger.error(`${messages.SQS.MESSAGE_ERROR_CREATE_QUEUE}: ${nameHandler}`);
      throw ex;
    }
  }

  private isFifoQueue(nameHandler: string): Boolean {
    const splitNameHandler = nameHandler.split('.');
    return splitNameHandler[splitNameHandler.length - 1] === 'fifo';
  }

  async addListener(handler: Function, nameHandler: string) {
    let queueUrl: string;

    queueUrl = await this.getQueueUrl(nameHandler);
    if (!queueUrl) {
      queueUrl = await this.createQueue(nameHandler);
    }

    this.poll(nameHandler, handler);
    Attivlogger.info(`${messages.SQS.MESSAGE_LISTENER_QUEUE}: ${nameHandler}`);
  }

  async receiveMessages(nameHandler, options = {}) {
    return this.getQueueUrl(nameHandler).then(queueUrl => {
      if (queueUrl == null) throw new Error(`${messages.SQS.MESSAGE_ERROR_FIND_QUEUE} '${nameHandler}'`);

      const params = {
        QueueUrl: queueUrl,
        WaitTimeSeconds: this.WaitTimeSeconds,
      };

      return this.SQS.receiveMessagePromise(params).then(({ Messages: messages }) => {
        if (!messages) return null;

        let deserialized = { ReceiptHandle: '', Body: '' };

        if (messages.length > 0) {
          messages.forEach(message => {
            try {
              deserialized.ReceiptHandle = message.ReceiptHandle;
              deserialized.Body = JSON.parse(message.Body);
            } catch (error) {
              deserialized = null;
              Attivlogger.info(`${messages.SQS.MESSAGE_JSON_INVALID}: ${nameHandler}`);
            }
          });
        } else {
          deserialized = null;
        }

        return deserialized;
      });
    });
  }

  async deleteMessage(nameHandler, receiptHandle) {
    return this.getQueueUrl(nameHandler).then(queueUrl => {
      if (queueUrl === null) throw new Error(`${messages.SQS.MESSAGE_ERROR_FIND_QUEUE} : ${nameHandler} `);

      const params = {
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      };
      return this.SQS.deleteMessagePromise(params);
    });
  }

  async processMessages(nameHandler, handler, message) {
    return handler(message.Body)
      .then(result => {
        this.deleteMessage(nameHandler, message.ReceiptHandle);
        return Promise.all(message).then(() => result);
      })
      .catch(error => { });
  }

  async poll(nameHandler, handler, options = {}) {
    return this.receiveMessages(nameHandler, options).then(message => {
      if (message) {
        Attivlogger.info(`${messages.SQS.MESSAGE_PROCESS}: ${nameHandler}`);
        return this.processMessages(nameHandler, handler, message).then(result => {
          if (result === false) {
            return null;
          }
          return this.poll(nameHandler, handler, options);
        });
      }
      return this.poll(nameHandler, handler, options);
    });
  }

  getChannels() {
    return this.subscribes;
  }

  getMessagesQueue(nameHandler: string) {
    throw new Error(messages.all.METHOD_NOT_IMPLEMENTED);
  }

  unsubscribe(nameHandler: string) {
    throw new Error(messages.all.METHOD_NOT_IMPLEMENTED);
  }

  sendAll(metadata: Metadata) {
    throw new Error(messages.all.METHOD_NOT_IMPLEMENTED);
  }
}
