/**
 * Test Idempotency Handler
 *
 * @group unit/idempotency/IdempotencyHandler
 */
import {
  IdempotencyAlreadyInProgressError,
  IdempotencyInconsistentStateError,
  IdempotencyItemAlreadyExistsError,
  IdempotencyPersistenceLayerError,
} from '../../src/errors';
import { IdempotencyRecord } from '../../src/persistence';
import { IdempotencyHandler } from '../../src/IdempotencyHandler';
import { IdempotencyConfig } from '../../src/';
import { MAX_RETRIES, IdempotencyRecordStatus } from '../../src/constants';
import { PersistenceLayerTestClass } from '../helpers/idempotencyUtils';

const mockFunctionToMakeIdempotent = jest.fn();
const mockFunctionPayloadToBeHashed = {};
const persistenceStore = new PersistenceLayerTestClass();
const mockIdempotencyOptions = {
  persistenceStore,
  dataKeywordArgument: 'testKeywordArgument',
  config: new IdempotencyConfig({}),
};

const idempotentHandler = new IdempotencyHandler({
  functionToMakeIdempotent: mockFunctionToMakeIdempotent,
  functionPayloadToBeHashed: mockFunctionPayloadToBeHashed,
  persistenceStore: mockIdempotencyOptions.persistenceStore,
  functionArguments: [],
  idempotencyConfig: mockIdempotencyOptions.config,
});

describe('Class IdempotencyHandler', () => {
  const ENVIRONMENT_VARIABLES = process.env;

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

  describe('Method: determineResultFromIdempotencyRecord', () => {
    test('when record is in progress and within expiry window, it rejects with IdempotencyAlreadyInProgressError', async () => {
      // Prepare
      const stubRecord = new IdempotencyRecord({
        idempotencyKey: 'idempotencyKey',
        expiryTimestamp: Date.now() + 1000, // should be in the future
        inProgressExpiryTimestamp: 0, // less than current time in milliseconds
        responseData: { responseData: 'responseData' },
        status: IdempotencyRecordStatus.INPROGRESS,
      });

      // Act & Assess
      expect(stubRecord.isExpired()).toBe(false);
      expect(stubRecord.getStatus()).toBe(IdempotencyRecordStatus.INPROGRESS);
      expect(() =>
        IdempotencyHandler.determineResultFromIdempotencyRecord(stubRecord)
      ).toThrow(IdempotencyAlreadyInProgressError);
    });

    test('when record is in progress and outside expiry window, it rejects with IdempotencyInconsistentStateError', async () => {
      // Prepare
      const stubRecord = new IdempotencyRecord({
        idempotencyKey: 'idempotencyKey',
        expiryTimestamp: Date.now() + 1000, // should be in the future
        inProgressExpiryTimestamp: new Date().getUTCMilliseconds() - 1000, // should be in the past
        responseData: { responseData: 'responseData' },
        status: IdempotencyRecordStatus.INPROGRESS,
      });

      // Act & Assess
      expect(stubRecord.isExpired()).toBe(false);
      expect(stubRecord.getStatus()).toBe(IdempotencyRecordStatus.INPROGRESS);
      expect(() =>
        IdempotencyHandler.determineResultFromIdempotencyRecord(stubRecord)
      ).toThrow(IdempotencyInconsistentStateError);
    });

    test('when record is expired, it rejects with IdempotencyInconsistentStateError', async () => {
      // Prepare
      const stubRecord = new IdempotencyRecord({
        idempotencyKey: 'idempotencyKey',
        expiryTimestamp: new Date().getUTCMilliseconds() - 1000, // should be in the past
        inProgressExpiryTimestamp: 0, // less than current time in milliseconds
        responseData: { responseData: 'responseData' },
        status: IdempotencyRecordStatus.EXPIRED,
      });

      // Act & Assess
      expect(stubRecord.isExpired()).toBe(true);
      expect(stubRecord.getStatus()).toBe(IdempotencyRecordStatus.EXPIRED);
      expect(() =>
        IdempotencyHandler.determineResultFromIdempotencyRecord(stubRecord)
      ).toThrow(IdempotencyInconsistentStateError);
    });
  });

  describe('Method: handle', () => {
    test('when IdempotencyAlreadyInProgressError is thrown, it retries once', async () => {
      // Arrange
      const existingRecord = new IdempotencyRecord({
        idempotencyKey: 'idempotence-key',
        status: 'COMPLETED',
        expiryTimestamp: Date.now() / 1000 - 1,
        responseData: { test: 'data' },
      });
      // Prepare
      const saveInProgressSpy = jest
        .spyOn(persistenceStore, 'saveInProgress')
        .mockRejectedValueOnce(
          new IdempotencyItemAlreadyExistsError(
            'Failed to put record for already existing idempotency key: idempotence-key',
            existingRecord
          )
        );

      // Act & Assess
      await expect(idempotentHandler.handle()).rejects.toThrow();
      expect(saveInProgressSpy).toHaveBeenCalledTimes(1);
    });

    test('when IdempotencyInconsistentStateError is thrown, it retries until max retries are exhausted', async () => {
      // Prepare
      const mockProcessIdempotency = jest
        .spyOn(persistenceStore, 'saveInProgress')
        .mockRejectedValue(
          new IdempotencyItemAlreadyExistsError(
            'Failed to put record for already existing idempotency key: my-lambda-function#mocked-hash',
            new IdempotencyRecord({
              idempotencyKey: 'my-lambda-function#mocked-hash',
              status: IdempotencyRecordStatus.EXPIRED,
              payloadHash: 'different-hash',
              expiryTimestamp: Date.now() / 1000 - 1,
            })
          )
        );
      jest.spyOn(persistenceStore, 'getRecord').mockResolvedValue(
        new IdempotencyRecord({
          status: IdempotencyRecordStatus.EXPIRED,
          idempotencyKey: 'idempotencyKey',
        })
      );

      // Act & Assess
      await expect(idempotentHandler.handle()).rejects.toThrow(
        IdempotencyInconsistentStateError
      );
      expect(mockProcessIdempotency).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    });
  });

  describe('Method: getFunctionResult', () => {
    test('when function returns a result, it saves the successful result and returns it', async () => {
      // Prepare
      mockFunctionToMakeIdempotent.mockResolvedValue('result');
      const mockSaveSuccessfulResult = jest
        .spyOn(mockIdempotencyOptions.persistenceStore, 'saveSuccess')
        .mockResolvedValue();

      // Act & Assess
      await expect(idempotentHandler.getFunctionResult()).resolves.toBe(
        'result'
      );
      expect(mockSaveSuccessfulResult).toHaveBeenCalledTimes(1);
    });

    test('when function throws an error, it deletes the in progress record and throws the error', async () => {
      // Prepare
      mockFunctionToMakeIdempotent.mockRejectedValue(new Error('Some error'));
      const mockDeleteInProgress = jest
        .spyOn(mockIdempotencyOptions.persistenceStore, 'deleteRecord')
        .mockResolvedValue();

      // Act & Assess
      await expect(idempotentHandler.getFunctionResult()).rejects.toThrow(
        Error
      );
      expect(mockDeleteInProgress).toHaveBeenCalledTimes(1);
    });

    test('when deleteRecord throws an error, it wraps the error to IdempotencyPersistenceLayerError', async () => {
      // Prepare
      mockFunctionToMakeIdempotent.mockRejectedValue(new Error('Some error'));
      const mockDeleteInProgress = jest
        .spyOn(mockIdempotencyOptions.persistenceStore, 'deleteRecord')
        .mockRejectedValue(new Error('Some error'));

      // Act & Assess
      await expect(idempotentHandler.getFunctionResult()).rejects.toThrow(
        new IdempotencyPersistenceLayerError(
          'Failed to delete record from idempotency store',
          new Error('Some error')
        )
      );
      expect(mockDeleteInProgress).toHaveBeenCalledTimes(1);
    });

    test('when saveSuccessfulResult throws an error, it wraps the error to IdempotencyPersistenceLayerError', async () => {
      // Prepare
      mockFunctionToMakeIdempotent.mockResolvedValue('result');
      const mockSaveSuccessfulResult = jest
        .spyOn(mockIdempotencyOptions.persistenceStore, 'saveSuccess')
        .mockRejectedValue(new Error('Some error'));

      // Act & Assess
      await expect(idempotentHandler.getFunctionResult()).rejects.toThrow(
        IdempotencyPersistenceLayerError
      );
      expect(mockSaveSuccessfulResult).toHaveBeenCalledTimes(1);
    });
  });
});
