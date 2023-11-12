/**
 * Test Idempotency middleware
 *
 * @group unit/idempotency/makeHandlerIdempotent
 */
import { makeHandlerIdempotent } from '../../src/middleware';
import { helloworldContext as dummyContext } from '@aws-lambda-powertools/commons/lib/samples/resources/contexts';
import { Custom as dummyEvent } from '@aws-lambda-powertools/commons/lib/samples/resources/events';
import { IdempotencyRecord } from '../../src/persistence';
import {
  IdempotencyInconsistentStateError,
  IdempotencyItemAlreadyExistsError,
  IdempotencyPersistenceLayerError,
} from '../../src/errors';
import { IdempotencyConfig } from '../../src/';
import middy from '@middy/core';
import { MAX_RETRIES, IdempotencyRecordStatus } from '../../src/constants';
import { PersistenceLayerTestClass } from '../helpers/idempotencyUtils';
import type { Context } from 'aws-lambda';

const mockIdempotencyOptions = {
  persistenceStore: new PersistenceLayerTestClass(),
};
const remainingTImeInMillis = 1234;

describe('Middleware: makeHandlerIdempotent', () => {
  const ENVIRONMENT_VARIABLES = process.env;
  const context = dummyContext;
  const event = dummyEvent.CustomEvent;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    process.env = { ...ENVIRONMENT_VARIABLES };
    jest.spyOn(console, 'debug').mockImplementation(() => null);
    jest.spyOn(console, 'warn').mockImplementation(() => null);
    jest.spyOn(console, 'error').mockImplementation(() => null);
  });

  afterAll(() => {
    process.env = ENVIRONMENT_VARIABLES;
  });

  it('handles a successful execution', async () => {
    // Prepare
    const handler = middy(
      async (_event: unknown, context: Context) => context.awsRequestId
    ).use(
      makeHandlerIdempotent({
        ...mockIdempotencyOptions,
        config: new IdempotencyConfig({}),
      })
    );
    const saveInProgressSpy = jest.spyOn(
      mockIdempotencyOptions.persistenceStore,
      'saveInProgress'
    );
    const saveSuccessSpy = jest.spyOn(
      mockIdempotencyOptions.persistenceStore,
      'saveSuccess'
    );

    // Act
    const result = await handler(event, context);

    // Assess
    expect(result).toBe(context.awsRequestId);
    expect(saveInProgressSpy).toHaveBeenCalledTimes(1);
    expect(saveInProgressSpy).toHaveBeenCalledWith(
      event,
      remainingTImeInMillis
    );
    expect(saveSuccessSpy).toHaveBeenCalledTimes(1);
    expect(saveSuccessSpy).toHaveBeenCalledWith(event, context.awsRequestId);
  });
  it('handles an execution that throws an error', async () => {
    // Prepare
    const handler = middy(
      async (_event: unknown, _context: Context): Promise<boolean> => {
        throw new Error('Something went wrong');
      }
    ).use(makeHandlerIdempotent(mockIdempotencyOptions));
    const saveInProgressSpy = jest.spyOn(
      mockIdempotencyOptions.persistenceStore,
      'saveInProgress'
    );
    const deleteRecordSpy = jest.spyOn(
      mockIdempotencyOptions.persistenceStore,
      'deleteRecord'
    );

    // Act && Assess
    await expect(handler(event, context)).rejects.toThrow();
    expect(saveInProgressSpy).toHaveBeenCalledTimes(1);
    expect(saveInProgressSpy).toHaveBeenCalledWith(
      event,
      remainingTImeInMillis
    );
    expect(deleteRecordSpy).toHaveBeenCalledTimes(1);
    expect(deleteRecordSpy).toHaveBeenCalledWith(event);
  });
  it('thows an error if the persistence layer throws an error when saving in progress', async () => {
    // Prepare
    const handler = middy(
      async (_event: unknown, _context: Context): Promise<boolean> => true
    ).use(makeHandlerIdempotent(mockIdempotencyOptions));
    jest
      .spyOn(mockIdempotencyOptions.persistenceStore, 'saveInProgress')
      .mockRejectedValue(new Error('Something went wrong'));

    // Act && Assess
    await expect(handler(event, context)).rejects.toThrowError(
      new IdempotencyPersistenceLayerError(
        'Failed to save in progress record to idempotency store',
        new Error('Something went wrong')
      )
    );
  });
  it('thows an error if the persistence layer throws an error when saving a successful operation', async () => {
    // Prepare
    const handler = middy(
      async (_event: unknown, _context: Context): Promise<boolean> => true
    ).use(makeHandlerIdempotent(mockIdempotencyOptions));
    jest
      .spyOn(mockIdempotencyOptions.persistenceStore, 'saveSuccess')
      .mockRejectedValue(new Error('Something went wrong'));

    // Act && Assess
    await expect(handler(event, context)).rejects.toThrowError(
      new IdempotencyPersistenceLayerError(
        'Failed to update success record to idempotency store',
        new Error('Something went wrong')
      )
    );
  });
  it('thows an error if the persistence layer throws an error when deleting a record', async () => {
    // Prepare
    const handler = middy(
      async (_event: unknown, _context: Context): Promise<boolean> => {
        throw new Error('Something went wrong');
      }
    ).use(makeHandlerIdempotent(mockIdempotencyOptions));
    jest
      .spyOn(mockIdempotencyOptions.persistenceStore, 'deleteRecord')
      .mockRejectedValue(new Error('Something went wrong'));

    // Act && Assess
    await expect(handler(event, context)).rejects.toThrow(
      new IdempotencyPersistenceLayerError(
        'Failed to delete record from idempotency store',
        new Error('Something went wrong')
      )
    );
  });
  it('returns the stored response if the operation has already been executed', async () => {
    // Prepare
    const handler = middy(
      async (_event: unknown, _context: Context): Promise<boolean> => true
    ).use(makeHandlerIdempotent(mockIdempotencyOptions));
    jest
      .spyOn(mockIdempotencyOptions.persistenceStore, 'saveInProgress')
      .mockRejectedValue(
        new IdempotencyItemAlreadyExistsError(
          'Failed to put record for already existing idempotency key: idempotencyKey',
          new IdempotencyRecord({
            idempotencyKey: 'idempotencyKey',
            expiryTimestamp: Date.now() + 10000,
            inProgressExpiryTimestamp: 0,
            responseData: { response: false },
            payloadHash: 'payloadHash',
            status: IdempotencyRecordStatus.COMPLETED,
          })
        )
      );
    const stubRecord = new IdempotencyRecord({
      idempotencyKey: 'idempotencyKey',
      expiryTimestamp: Date.now() + 10000,
      inProgressExpiryTimestamp: 0,
      responseData: { response: false },
      payloadHash: 'payloadHash',
      status: IdempotencyRecordStatus.COMPLETED,
    });
    const getRecordSpy = jest
      .spyOn(mockIdempotencyOptions.persistenceStore, 'getRecord')
      .mockResolvedValue(stubRecord);

    // Act
    const result = await handler(event, context);

    // Assess
    expect(result).toStrictEqual({ response: false });
    expect(getRecordSpy).toHaveBeenCalledTimes(1);
    expect(getRecordSpy).toHaveBeenCalledWith(event);
  });
  it('retries if the record is in an inconsistent state', async () => {
    // Prepare
    const handler = middy(
      async (_event: unknown, _context: Context): Promise<boolean> => true
    ).use(makeHandlerIdempotent(mockIdempotencyOptions));
    jest
      .spyOn(mockIdempotencyOptions.persistenceStore, 'saveInProgress')
      .mockRejectedValue(
        new IdempotencyItemAlreadyExistsError(
          'Failed to put record for already existing idempotency key: idempotencyKey',
          new IdempotencyRecord({
            idempotencyKey: 'idempotencyKey',
            expiryTimestamp: Date.now() + 10000,
            inProgressExpiryTimestamp: 0,
            responseData: { response: false },
            payloadHash: 'payloadHash',
            status: IdempotencyRecordStatus.EXPIRED,
          })
        )
      );
    const stubRecordInconsistent = new IdempotencyRecord({
      idempotencyKey: 'idempotencyKey',
      expiryTimestamp: Date.now() + 10000,
      inProgressExpiryTimestamp: 0,
      responseData: { response: false },
      payloadHash: 'payloadHash',
      status: IdempotencyRecordStatus.EXPIRED,
    });
    const stubRecord = new IdempotencyRecord({
      idempotencyKey: 'idempotencyKey',
      expiryTimestamp: Date.now() + 10000,
      inProgressExpiryTimestamp: 0,
      responseData: { response: false },
      payloadHash: 'payloadHash',
      status: IdempotencyRecordStatus.COMPLETED,
    });
    const getRecordSpy = jest
      .spyOn(mockIdempotencyOptions.persistenceStore, 'getRecord')
      .mockResolvedValueOnce(stubRecordInconsistent)
      .mockResolvedValueOnce(stubRecord);

    // Act
    const result = await handler(event, context);

    // Assess
    expect(result).toStrictEqual({ response: false });
    expect(getRecordSpy).toHaveBeenCalledTimes(2);
  });
  it('throws after all the retries have been exhausted if the record is in an inconsistent state', async () => {
    // Prepare
    const handler = middy(
      async (_event: unknown, _context: Context): Promise<boolean> => true
    ).use(makeHandlerIdempotent(mockIdempotencyOptions));
    jest
      .spyOn(mockIdempotencyOptions.persistenceStore, 'saveInProgress')
      .mockRejectedValue(
        new IdempotencyItemAlreadyExistsError(
          'Failed to put record for already existing idempotency key: idempotencyKey',
          new IdempotencyRecord({
            idempotencyKey: 'idempotencyKey',
            expiryTimestamp: Date.now() + 10000,
            inProgressExpiryTimestamp: 0,
            responseData: { response: false },
            payloadHash: 'payloadHash',
            status: IdempotencyRecordStatus.EXPIRED,
          })
        )
      );
    const stubRecordInconsistent = new IdempotencyRecord({
      idempotencyKey: 'idempotencyKey',
      expiryTimestamp: Date.now() + 10000,
      inProgressExpiryTimestamp: 0,
      responseData: { response: false },
      payloadHash: 'payloadHash',
      status: IdempotencyRecordStatus.EXPIRED,
    });
    const getRecordSpy = jest
      .spyOn(mockIdempotencyOptions.persistenceStore, 'getRecord')
      .mockResolvedValue(stubRecordInconsistent);

    // Act & Assess
    await expect(handler(event, context)).rejects.toThrowError(
      new IdempotencyInconsistentStateError(
        'Item has expired during processing and may not longer be valid.'
      )
    );
    expect(getRecordSpy).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });
  it('does not do anything if idempotency is disabled', async () => {
    // Prepare
    process.env.POWERTOOLS_IDEMPOTENCY_DISABLED = 'true';
    const handler = middy(
      async (_event: unknown, _context: Context): Promise<boolean> => true
    ).use(makeHandlerIdempotent(mockIdempotencyOptions));
    const saveInProgressSpy = jest.spyOn(
      mockIdempotencyOptions.persistenceStore,
      'saveInProgress'
    );
    const saveSuccessSpy = jest.spyOn(
      mockIdempotencyOptions.persistenceStore,
      'saveSuccess'
    );

    // Act
    const result = await handler(event, context);

    // Assess
    expect(result).toBe(true);
    expect(saveInProgressSpy).toHaveBeenCalledTimes(0);
    expect(saveSuccessSpy).toHaveBeenCalledTimes(0);
  });

  it('skips idempotency if no idempotency key is provided and throwOnNoIdempotencyKey is false', async () => {
    // Prepare
    const handler = middy(
      async (_event: unknown, _context: Context): Promise<boolean> => true
    ).use(
      makeHandlerIdempotent({
        ...mockIdempotencyOptions,
        config: new IdempotencyConfig({
          eventKeyJmesPath: 'idempotencyKey',
          throwOnNoIdempotencyKey: false,
        }),
      })
    );
    const saveInProgressSpy = jest.spyOn(
      mockIdempotencyOptions.persistenceStore,
      'saveInProgress'
    );
    const saveSuccessSpy = jest.spyOn(
      mockIdempotencyOptions.persistenceStore,
      'saveSuccess'
    );

    // Act
    const result = await handler(event, context);

    // Assess
    expect(result).toBe(true);
    expect(saveInProgressSpy).toHaveBeenCalledTimes(0);
    expect(saveSuccessSpy).toHaveBeenCalledTimes(0);
  });

  it('skips idempotency if error is thrown in the middleware', async () => {
    const handler = middy(
      async (_event: unknown, _context: Context): Promise<void> => {
        throw new Error('Something went wrong');
      }
    ).use(
      makeHandlerIdempotent({
        ...mockIdempotencyOptions,
        config: new IdempotencyConfig({
          eventKeyJmesPath: 'idempotencyKey',
          throwOnNoIdempotencyKey: false,
        }),
      })
    );

    const deleteRecordSpy = jest.spyOn(
      mockIdempotencyOptions.persistenceStore,
      'deleteRecord'
    );

    await expect(handler(event, context)).rejects.toThrowError();

    expect(deleteRecordSpy).toHaveBeenCalledTimes(0);
  });
});
