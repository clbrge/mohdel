import { describe, test, expect, vi, beforeEach } from 'vitest';
import modhel from '../src/index.js';
import groqSDK from '../src/sdk/groq.js'; // For testing the SDK directly
import * as common from '../src/common.js'; // To mock its functions

// Mock groq-sdk
const mockChatCompletionsCreate = vi.fn();
const mockModelsList = vi.fn();
const mockModelsRetrieve = vi.fn();

vi.mock('groq-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ // Mocks the default export: Groq class
    chat: {
      completions: {
        create: mockChatCompletionsCreate,
      },
    },
    models: {
      list: mockModelsList,
      retrieve: mockModelsRetrieve,
    },
  })),
}));

// Mock src/common.js
vi.mock('../src/common.js', async (importOriginal) => {
  const actual = await importOriginal() || {};
  return {
    ...actual,
    getAPIKey: vi.fn(),
    getCuratedModels: vi.fn(),
    getDefaultModelId: vi.fn(),
  };
});

const mockGroqModelId = 'groq/llama3-8b-8192';
const mockGroqModelSpec = {
  model: 'llama3-8b-8192', // Actual model name for the API
  outputTokenLimit: 8192,
  sdk: 'groq',
  label: 'Llama3 8B',
};
const mockAnotherGroqModelId = 'groq/mixtral-8x7b-32768';
const mockAnotherGroqModelSpec = {
  model: 'mixtral-8x7b-32768',
  outputTokenLimit: 32768,
  sdk: 'groq',
  label: 'Mixtral 8x7B',
};

const mockCuratedModels = {
  [mockGroqModelId]: mockGroqModelSpec,
  [mockAnotherGroqModelId]: mockAnotherGroqModelSpec,
  'openai/gpt-4': { model: 'gpt-4', outputTokenLimit: 8000, sdk: 'openai' } // Other provider
};

describe('Groq Provider', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Setup default mocks for common.js functions
    common.getAPIKey.mockReturnValue('test-groq-api-key');
    common.getCuratedModels.mockResolvedValue(JSON.parse(JSON.stringify(mockCuratedModels)));

    // Default successful response for Groq API calls
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'Mocked Groq response text.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 25, total_tokens: 35 },
    });
    mockModelsList.mockResolvedValue({
      data: [{ id: 'llama3-8b-8192', name: 'Llama3 8B Groq' }]
    });
    mockModelsRetrieve.mockResolvedValue({
      id: 'llama3-8b-8192',
      name: 'Llama3 8B Groq Full',
      active: true,
      max_completion_tokens: 8000, // field for translation
      context_window: 8192,       // field for translation
    });
  });

  describe('modhel("groq/...").answer()', () => {
    const prompt = 'Hello, Groq!';

    test('should call groq.chat.completions.create with correct parameters and return formatted response', async () => {
      const instance = modhel(mockGroqModelId);
      const response = await instance.answer(prompt); // Default options

      expect(common.getAPIKey).toHaveBeenCalledWith('GROQ_API_SK');
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith({
        model: mockGroqModelSpec.model,
        temperature: 0,
        max_completion_tokens: mockGroqModelSpec.outputTokenLimit, // default from spec
        messages: [{ role: 'user', content: prompt }],
      });
      expect(response).toEqual({
        output: 'Mocked Groq response text.',
        inputTokens: 10,
        outputTokens: 25,
        thinkingTokens: 0, // Groq usage object doesn't have thinking/queue time for this field
      });
    });

    test('should respect options.outputBudget for max_completion_tokens', async () => {
      const instance = modhel(mockGroqModelId);
      const outputBudget = 1000;
      await instance.answer(prompt, { outputBudget });

      expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_completion_tokens: outputBudget })
      );
    });
    
    test('should cap options.outputBudget at model`s outputTokenLimit', async () => {
      const instance = modhel(mockGroqModelId);
      const outputBudget = mockGroqModelSpec.outputTokenLimit + 500; // Exceeds limit
      await instance.answer(prompt, { outputBudget });

      expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_completion_tokens: mockGroqModelSpec.outputTokenLimit })
      );
    });

    test('should handle API errors gracefully', async () => {
      const apiError = new Error('Groq API Error');
      mockChatCompletionsCreate.mockRejectedValue(apiError);
      const instance = modhel(mockGroqModelId);

      await expect(instance.answer(prompt)).rejects.toThrow(apiError);
    });
  });

  describe('modhel("groq/...").completion()', () => {
    const prompt = 'Complete this for Groq.';

    test('should call answer internally and return just the text output', async () => {
      const instance = modhel(mockGroqModelId);
      const result = await instance.completion(prompt);

      expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ messages: [{ role: 'user', content: prompt }] })
      );
      expect(result).toBe('Mocked Groq response text.');
    });

    test('should handle errors from internal answer call', async () => {
      const apiError = new Error('Groq API Error from completion');
      mockChatCompletionsCreate.mockRejectedValue(apiError);
      const instance = modhel(mockGroqModelId);

      await expect(instance.completion(prompt)).rejects.toThrow(apiError);
    });
  });

  describe('groqSDK direct tests', () => {
    let sdk;
    // dangerouslyAllowBrowser is part of the Groq SDK config
    const sdkDefaultConfig = { apiKey: 'sdk-test-key-direct', dangerouslyAllowBrowser: true };
    const sdkSpecs = { 
        [mockGroqModelId]: mockGroqModelSpec,
        [mockAnotherGroqModelId]: mockAnotherGroqModelSpec
    };

    beforeEach(() => {
      // SDK is instantiated with its own config, not from common.js
      sdk = groqSDK(sdkDefaultConfig, sdkSpecs);
    });

    describe('sdk.listModels()', () => {
      test('should call groq.models.list and return data', async () => {
        const models = await sdk.listModels();
        expect(mockModelsList).toHaveBeenCalledTimes(1);
        // The mock returns the raw data structure from Groq SDK
        expect(models.data).toEqual([{ id: 'llama3-8b-8192', name: 'Llama3 8B Groq' }]);
      });

      test('should return empty array on API error', async () => {
        mockModelsList.mockRejectedValue(new Error('List models API error'));
        const models = await sdk.listModels();
        expect(models).toEqual([]); // As per current SDK implementation
      });
    });

    describe('sdk.getModelInfo()', () => {
      const modelIdToRetrieve = 'llama3-8b-8192';
      test('should call groq.models.retrieve and return translated info', async () => {
        const modelInfo = await sdk.getModelInfo(modelIdToRetrieve);
        expect(mockModelsRetrieve).toHaveBeenCalledWith(modelIdToRetrieve);
        expect(modelInfo).toEqual({
          id: 'llama3-8b-8192',
          name: 'Llama3 8B Groq Full',
          active: true,
          outputTokenLimit: 8000, // translated from max_completion_tokens
          inputTokenLimit: 8192,  // translated from context_window
        });
      });

      test('should return null on API error', async () => {
        mockModelsRetrieve.mockRejectedValue(new Error('Retrieve model API error'));
        const modelInfo = await sdk.getModelInfo(modelIdToRetrieve);
        expect(modelInfo).toBeNull();
      });
    });

    describe('sdk.call()', () => {
      const modelToCall = 'llama3-8b-8192';
      const callArgs = { messages: [{ role: 'user', content: 'Direct call test' }] };

      test('should call groq.chat.completions.create with provided model and args', async () => {
        await sdk.call(modelToCall)(callArgs);
        expect(mockChatCompletionsCreate).toHaveBeenCalledWith({
          ...callArgs,
          model: modelToCall,
        });
      });
      
      test('sdk.call can use a different Groq instance if configuration is passed', async () => {
            const runtimeConfig = { apiKey: 'runtime-key-groq', dangerouslyAllowBrowser: false };
            const localMockChatCreate = vi.fn().mockResolvedValue({
                 choices: [{ message: { content: 'Local mock response' } }],
                 usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            });
            
            const OriginalGroqMock = vi.mocked(require('groq-sdk').default);
            OriginalGroqMock.mockImplementationOnce(() => ({
                 chat: { completions: { create: localMockChatCreate }},
                 models: { list: vi.fn(), retrieve: vi.fn() } // Need to mock other methods too
            }));

            await sdk.call(modelToCall, runtimeConfig)(callArgs);
            
            expect(OriginalGroqMock).toHaveBeenCalledWith(runtimeConfig); // No merging with default for sdk.call
            expect(localMockChatCreate).toHaveBeenCalledWith({ ...callArgs, model: modelToCall });
            expect(mockChatCompletionsCreate).not.toHaveBeenCalled(); 
        });

      test('should handle API errors gracefully for sdk.call', async () => {
        const apiError = new Error('SDK Call API Error');
        mockChatCompletionsCreate.mockRejectedValue(apiError);
        await expect(sdk.call(modelToCall)(callArgs)).rejects.toThrow(apiError);
      });
    });
    
    describe('sdk.answer() (direct SDK method)', () => {
        const prompt = 'SDK direct answer for Groq';
        
        test('should call groq.chat.completions.create with correct parameters', async () => {
            const sdkInstance = groqSDK(sdkDefaultConfig, sdkSpecs);
            const options = { outputBudget: 200 };
            await sdkInstance.answer(mockGroqModelId)(prompt, options);

            expect(mockChatCompletionsCreate).toHaveBeenCalledWith({
                model: mockGroqModelSpec.model, // From sdkSpecs
                temperature: 0,
                max_completion_tokens: options.outputBudget,
                messages: [{ role: 'user', content: prompt }],
            });
        });

        test('sdk.answer should use default outputTokenLimit if outputBudget is not set', async () => {
            const sdkInstance = groqSDK(sdkDefaultConfig, sdkSpecs);
            await sdkInstance.answer(mockGroqModelId)(prompt, {}); // Empty options
            
            expect(mockChatCompletionsCreate).toHaveBeenCalledWith(expect.objectContaining({
                max_completion_tokens: mockGroqModelSpec.outputTokenLimit
            }));
        });
        
        test('sdk.answer can use a different Groq instance if configuration is passed', async () => {
            const sdkInstance = groqSDK(sdkDefaultConfig, sdkSpecs);
            const runtimeConfig = { apiKey: 'runtime-key-groq-answer', dangerouslyAllowBrowser: false };
            const localMockChatCreate = vi.fn().mockResolvedValue({
                 choices: [{ message: { content: 'Local mock response from answer' } }],
                 usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
            });
            
            const OriginalGroqMock = vi.mocked(require('groq-sdk').default);
            OriginalGroqMock.mockImplementationOnce(() => ({
                 chat: { completions: { create: localMockChatCreate }},
                 models: { list: vi.fn(), retrieve: vi.fn() }
            }));

            await sdkInstance.answer(mockGroqModelId, runtimeConfig)(prompt, {});
            
            expect(OriginalGroqMock).toHaveBeenCalledWith({ ...sdkDefaultConfig, ...runtimeConfig });
            expect(localMockChatCreate).toHaveBeenCalledWith(expect.objectContaining({
                model: mockGroqModelSpec.model,
            }));
            expect(mockChatCompletionsCreate).not.toHaveBeenCalled(); 
        });
    });
  });
});
