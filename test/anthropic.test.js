import { describe, test, expect, vi, beforeEach } from 'vitest';
import modhel from '../src/index.js';
import anthropicSDK from '../src/sdk/anthropic.js'; // For testing the SDK directly
import * as common from '../src/common.js'; // To mock its functions

// Mock @anthropic-ai/sdk
const mockMessagesCreate = vi.fn();
const mockModelsList = vi.fn();
const mockModelsRetrieve = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockMessagesCreate },
      models: { list: mockModelsList, retrieve: mockModelsRetrieve },
    })),
    Anthropic: vi.fn().mockImplementation(() => ({ // Also mock named export if used by SDK
      messages: { create: mockMessagesCreate },
      models: { list: mockModelsList, retrieve: mockModelsRetrieve },
    })),
  };
});

// Mock src/common.js
vi.mock('../src/common.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAPIKey: vi.fn(),
    getCuratedModels: vi.fn(),
    getDefaultModelId: vi.fn(), // Though not directly used by these tests, good to mock
  };
});

const mockAnthropicModelId = 'anthropic/claude-3-sonnet-latest';
const mockAnthropicModelSpec = {
  model: 'claude-3-sonnet-20240229', // Actual model name for the API
  outputTokenLimit: 8192, // Increased from 4096 to test outputBudget scenario
  sdk: 'anthropic',
  label: 'Claude 3 Sonnet Latest',
};
const mockCuratedModels = {
  [mockAnthropicModelId]: mockAnthropicModelSpec,
  'anthropic/claude-3-opus-latest': { model: 'claude-3-opus-20240229', outputTokenLimit: 4096, sdk: 'anthropic', label: 'Claude 3 Opus Latest'},
  // Add other provider models to ensure provider selection logic works, but not strictly necessary for these specific tests
  'openai/gpt-4': { model: 'gpt-4', outputTokenLimit: 8000, sdk: 'openai' }
};


describe('Anthropic Provider', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Setup default mocks for common.js functions
    common.getAPIKey.mockReturnValue('test-anthropic-api-key');
    common.getCuratedModels.mockResolvedValue(JSON.parse(JSON.stringify(mockCuratedModels)));

    // Default successful response for Anthropic API calls
    mockMessagesCreate.mockResolvedValue({
      content: [{ text: 'Mocked Anthropic response text.' }],
      usage: { input_tokens: 10, output_tokens: 25 },
    });
    mockModelsList.mockResolvedValue({
      data: [{ id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' }]
    });
    mockModelsRetrieve.mockResolvedValue({
      id: 'claude-3-sonnet-20240229',
      name: 'Claude 3 Sonnet',
      display_name: 'Claude Sonnet 3', // example field for translation
      created_at: '2024-02-29T00:00:00Z'
    });
  });

  describe('modhel("anthropic/...").answer()', () => {
    const prompt = 'Hello, Anthropic!';

    test('should call anthropic.messages.create with correct parameters and return formatted response', async () => {
      const instance = modhel(mockAnthropicModelId);
      const response = await instance.answer(prompt);

      expect(common.getAPIKey).toHaveBeenCalledWith('ANTHROPIC_API_SK');
      expect(mockMessagesCreate).toHaveBeenCalledWith({
        model: mockAnthropicModelSpec.model,
        temperature: 0,
        max_tokens: mockAnthropicModelSpec.outputTokenLimit,
        messages: [{ role: 'user', content: prompt }],
      });
      expect(response).toEqual({
        output: 'Mocked Anthropic response text.',
        inputTokens: 10,
        outputTokens: 25,
        thinkingTokens: 0,
      });
    });

    test('should respect options.outputBudget for max_tokens if within limit', async () => {
      const instance = modhel(mockAnthropicModelId);
      const outputBudget = 1000;
      await instance.answer(prompt, { outputBudget });

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: outputBudget })
      );
    });
    
    test('should cap options.outputBudget at model`s outputTokenLimit', async () => {
      const instance = modhel(mockAnthropicModelId);
      const outputBudget = mockAnthropicModelSpec.outputTokenLimit + 500; // Exceeds limit
      await instance.answer(prompt, { outputBudget });

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: mockAnthropicModelSpec.outputTokenLimit })
      );
    });

    test('should include metadata.user_id if options.identifier is provided', async () => {
      const instance = modhel(mockAnthropicModelId);
      const identifier = 'user-123-test';
      await instance.answer(prompt, { identifier });

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { user_id: identifier } })
      );
    });

    test('should handle API errors gracefully', async () => {
      const apiError = new Error('Anthropic API Error');
      mockMessagesCreate.mockRejectedValue(apiError);
      const instance = modhel(mockAnthropicModelId);

      await expect(instance.answer(prompt)).rejects.toThrow(apiError);
    });
  });

  describe('modhel("anthropic/...").completion()', () => {
    const prompt = 'Complete this for Anthropic.';

    test('should call answer internally and return just the text output', async () => {
      const instance = modhel(mockAnthropicModelId);
      const result = await instance.completion(prompt);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ messages: [{ role: 'user', content: prompt }] })
      );
      expect(result).toBe('Mocked Anthropic response text.');
    });

    test('should handle errors from internal answer call', async () => {
      const apiError = new Error('Anthropic API Error from completion');
      mockMessagesCreate.mockRejectedValue(apiError);
      const instance = modhel(mockAnthropicModelId);

      await expect(instance.completion(prompt)).rejects.toThrow(apiError);
    });
  });

  describe('anthropicSDK direct tests', () => {
    let sdk;
    const sdkDefaultConfig = { apiKey: 'sdk-test-key' };
    const sdkSpecs = { [mockAnthropicModelId]: mockAnthropicModelSpec };

    beforeEach(() => {
      // SDK is instantiated with its own config, not from common.js
      sdk = anthropicSDK(sdkDefaultConfig, sdkSpecs);
    });

    describe('sdk.listModels()', () => {
      test('should call anthropic.models.list and return data', async () => {
        const models = await sdk.listModels();
        expect(mockModelsList).toHaveBeenCalledTimes(1);
        expect(models.data).toEqual([{ id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' }]);
      });

      test('should return empty data array on API error', async () => {
        mockModelsList.mockRejectedValue(new Error('List models API error'));
        const models = await sdk.listModels();
        expect(models).toEqual({ data: [] });
      });
    });

    describe('sdk.getModelInfo()', () => {
      const modelIdToRetrieve = 'claude-3-sonnet-20240229';
      test('should call anthropic.models.retrieve and return translated info', async () => {
        const modelInfo = await sdk.getModelInfo(modelIdToRetrieve);
        expect(mockModelsRetrieve).toHaveBeenCalledWith(modelIdToRetrieve);
        expect(modelInfo).toEqual({
          id: 'claude-3-sonnet-20240229',
          name: 'Claude 3 Sonnet',
          displayName: 'Claude Sonnet 3',
          createdAt: '2024-02-29T00:00:00Z'
          // other translated fields if any
        });
      });

      test('should return null on API error', async () => {
        mockModelsRetrieve.mockRejectedValue(new Error('Retrieve model API error'));
        const modelInfo = await sdk.getModelInfo(modelIdToRetrieve);
        expect(modelInfo).toBeNull();
      });
    });

    describe('sdk.completion() (direct SDK method)', () => {
      const prompt = 'SDK direct completion';
      const modelFullName = mockAnthropicModelId; // Uses the full ID from specs

      test('should call anthropic.messages.create with correct parameters', async () => {
        // Note: The SDK's own completion doesn't use the 'specs' for model name or outputTokenLimit directly in its call to messages.create
        // It uses the passed modelName and a hardcoded max_tokens.
        // This is different from the `answer` method.
        const specificModelNameForSdkCompletion = 'claude-3-sonnet-20240229'; // This is what the SDK's completion expects
        
        // Re-configure mockCuratedModels for this specific SDK completion test if needed
        // For this test, we are calling sdk.completion directly with the modelName.
        // The specs are primarily for the `answer` method.
        // The anthropicSDK's own `completion` method takes modelName (e.g. "claude-3-sonnet-20240229")
        
        // The `completion` method on the SDK itself is slightly different:
        // it takes the model name directly (e.g. 'claude-3-sonnet-20240229')
        // not the full 'anthropic/claude-3-sonnet-latest'
        
        const sdkInstance = anthropicSDK(sdkDefaultConfig, {
            // Specs for the SDK's `answer` method, not its `completion` method's model arg
            'anthropic/claude-3-sonnet-latest': { model: 'claude-3-sonnet-20240229', outputTokenLimit: 4096 }
        });

        await sdkInstance.completion('claude-3-sonnet-20240229')(prompt);

        expect(mockMessagesCreate).toHaveBeenCalledWith({
          model: 'claude-3-sonnet-20240229', // The exact model name passed to sdk.completion
          max_tokens: 4096, // Hardcoded in anthropicSDK.js's completion
          messages: [{ role: 'user', content: prompt }],
        });
        // The response from the mock is { content: [{ text: '...' }], ... }
        // The sdk.completion returns response.content[0].text
        const result = await sdkInstance.completion('claude-3-sonnet-20240229')(prompt);
        expect(result).toBe('Mocked Anthropic response text.');
      });

      test('should handle API errors gracefully for sdk.completion', async () => {
         const sdkInstance = anthropicSDK(sdkDefaultConfig, {});
        const apiError = new Error('SDK Completion API Error');
        mockMessagesCreate.mockRejectedValue(apiError);
        await expect(sdkInstance.completion('claude-3-sonnet-20240229')(prompt)).rejects.toThrow(apiError);
      });
    });
    
    describe('sdk.answer() (direct SDK method)', () => {
        const prompt = 'SDK direct answer';
        const modelFullNameInSpecs = mockAnthropicModelId; // e.g. 'anthropic/claude-3-sonnet-latest'

        test('should call anthropic.messages.create with correct parameters via sdk.answer', async () => {
            const sdkInstance = anthropicSDK(sdkDefaultConfig, sdkSpecs);
            const response = await sdkInstance.answer(modelFullNameInSpecs)(prompt, { outputBudget: 500 });

            expect(mockMessagesCreate).toHaveBeenCalledWith({
                model: mockAnthropicModelSpec.model, // from sdkSpecs
                temperature: 0,
                max_tokens: 500, // from options.outputBudget
                messages: [{ role: 'user', content: prompt }],
            });
            expect(response).toEqual({
                output: 'Mocked Anthropic response text.',
                inputTokens: 10,
                outputTokens: 25,
                thinkingTokens: 0,
            });
        });

        test('sdk.answer should respect outputTokenLimit from spec if options.outputBudget is higher', async () => {
            const sdkInstance = anthropicSDK(sdkDefaultConfig, sdkSpecs);
            await sdkInstance.answer(modelFullNameInSpecs)(prompt, { outputBudget: mockAnthropicModelSpec.outputTokenLimit + 1000 });
            
            expect(mockMessagesCreate).toHaveBeenCalledWith(expect.objectContaining({
                max_tokens: mockAnthropicModelSpec.outputTokenLimit
            }));
        });

        test('sdk.answer should use default outputTokenLimit from spec if no options.outputBudget', async () => {
            const sdkInstance = anthropicSDK(sdkDefaultConfig, sdkSpecs);
            await sdkInstance.answer(modelFullNameInSpecs)(prompt, {}); // Empty options
            
            expect(mockMessagesCreate).toHaveBeenCalledWith(expect.objectContaining({
                max_tokens: mockAnthropicModelSpec.outputTokenLimit
            }));
        });
        
        test('sdk.answer should handle API errors gracefully', async () => {
            const sdkInstance = anthropicSDK(sdkDefaultConfig, sdkSpecs);
            const apiError = new Error('SDK Answer API Error');
            mockMessagesCreate.mockRejectedValue(apiError);
            await expect(sdkInstance.answer(modelFullNameInSpecs)(prompt, {})).rejects.toThrow(apiError);
        });

        test('sdk.answer can use a different Anthropic instance if configuration is passed', async () => {
            const sdkInstance = anthropicSDK(sdkDefaultConfig, sdkSpecs);
            const runtimeConfig = { apiKey: 'runtime-key', maxRetries: 5 };
            const localMockMessagesCreate = vi.fn().mockResolvedValue({ // A separate mock for this specific test
                 content: [{ text: 'Local mock response' }],
                 usage: { input_tokens: 5, output_tokens: 15 },
            });
            
            // Temporarily change the mock implementation for the Anthropic constructor
            // This is a bit tricky because the original mock is module-level.
            // We're testing if a *new* Anthropic instance is created.
            // So we need the Anthropic constructor mock to return an object with this new mock.
            const OriginalAnthropicMock = vi.mocked(require('@anthropic-ai/sdk').default);
            OriginalAnthropicMock.mockImplementationOnce(() => ({ // Mock the next instantiation
                 messages: { create: localMockMessagesCreate },
                 // models: ... (if other methods were called by this path)
            }));

            await sdkInstance.answer(modelFullNameInSpecs, runtimeConfig)(prompt, {});
            
            expect(OriginalAnthropicMock).toHaveBeenCalledWith({ ...sdkDefaultConfig, ...runtimeConfig });
            expect(localMockMessagesCreate).toHaveBeenCalledWith(expect.objectContaining({
                model: mockAnthropicModelSpec.model,
            }));
            expect(mockMessagesCreate).not.toHaveBeenCalled(); // Ensure the global mock wasn't called
        });
    });
  });
});
