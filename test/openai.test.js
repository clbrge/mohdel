import { describe, test, expect, vi, beforeEach } from 'vitest';
import modhel from '../src/index.js';
import openaiSDK from '../src/sdk/openai.js'; // For testing the SDK directly
import * as common from '../src/common.js'; // To mock its functions

// Mock openai SDK
const mockChatCompletionsCreate = vi.fn();
const mockResponsesCreate = vi.fn();
const mockModelsList = vi.fn();
const mockModelsRetrieve = vi.fn();

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChatCompletionsCreate } },
    responses: { create: mockResponsesCreate },
    models: { list: mockModelsList, retrieve: mockModelsRetrieve },
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

const mockOpenAIModelId = 'openai/gpt-4-turbo';
const mockOpenAIModelSpec = {
  model: 'gpt-4-turbo', // Actual model name for the API
  outputTokenLimit: 8192,
  sdk: 'openai',
  label: 'GPT-4 Turbo',
  thinkingEffortLevels: { low: 'low_effort', medium: 'auto', high: 'high_effort' }, // Example thinking levels
};
const mockDeepSeekModelId = 'deepseek/deepseek-chat'; // Example DeepSeek model
const mockDeepSeekModelSpec = {
  model: 'deepseek-chat',
  outputTokenLimit: 4096,
  sdk: 'openai', // Uses openaiSDK
  provider: 'deepseek', // Special flag for routing within openaiSDK
  label: 'DeepSeek Chat',
};

const mockCuratedModels = {
  [mockOpenAIModelId]: mockOpenAIModelSpec,
  'openai/gpt-3.5-turbo': { model: 'gpt-3.5-turbo', outputTokenLimit: 4096, sdk: 'openai', label: 'GPT-3.5 Turbo' },
  [mockDeepSeekModelId]: mockDeepSeekModelSpec,
};

describe('OpenAI Provider', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    common.getAPIKey.mockImplementation(envVar => {
      if (envVar === 'OPENAI_API_SK') return 'test-openai-api-key';
      if (envVar === 'DEEPSEEK_API_SK') return 'test-deepseek-api-key';
      return null;
    });
    common.getCuratedModels.mockResolvedValue(JSON.parse(JSON.stringify(mockCuratedModels)));

    mockResponsesCreate.mockResolvedValue({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Mocked OpenAI Responses API response.' }] }],
      usage: { input_tokens: 10, output_tokens: 30, output_tokens_details: { reasoning_tokens: 5 } }, // output_tokens includes reasoning
    });
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'Mocked OpenAI Chat Completions API response.' } }],
      usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
    });
    mockModelsList.mockResolvedValue({
      data: [{ id: 'gpt-4-turbo', name: 'GPT-4 Turbo Model' }]
    });
    mockModelsRetrieve.mockResolvedValue({
      id: 'gpt-4-turbo', name: 'GPT-4 Turbo Full Details', owned_by: 'openai'
    });
  });

  describe('modhel("openai/...").answer()', () => {
    const prompt = 'Hello, OpenAI!';

    test('should call openai.responses.create with correct parameters and return formatted response', async () => {
      const instance = modhel(mockOpenAIModelId);
      const response = await instance.answer(prompt);

      expect(common.getAPIKey).toHaveBeenCalledWith('OPENAI_API_SK');
      expect(mockResponsesCreate).toHaveBeenCalledWith({
        model: mockOpenAIModelSpec.model,
        temperature: 0,
        input: prompt,
        store: false,
        max_output_tokens: mockOpenAIModelSpec.outputTokenLimit,
        // reasoning not included by default if outputEffort not specified
      });
      expect(response).toEqual({
        output: 'Mocked OpenAI Responses API response.',
        inputTokens: 10,
        outputTokens: 25, // 30 (total output) - 5 (reasoning)
        thinkingTokens: 5,
      });
    });

    test('should handle options.outputBudget, outputEffort, outputType, identifier, images', async () => {
      const instance = modhel(mockOpenAIModelId);
      const options = {
        outputBudget: 1000,
        outputEffort: 'high',
        outputType: 'json',
        identifier: 'user-test-123',
        images: [{ data: 'base64data', mimetype: 'image/png' }]
      };
      await instance.answer(prompt, options);

      expect(mockResponsesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          max_output_tokens: options.outputBudget,
          reasoning: { effort: mockOpenAIModelSpec.thinkingEffortLevels[options.outputEffort] },
          text: { format: { type: 'json_object' } },
          user: options.identifier,
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'image_url', image_url: 'data:image/png;base64,base64data', detail: 'high' }
            ]
          }]
        })
      );
    });
    
    test('should cap options.outputBudget at model`s outputTokenLimit', async () => {
      const instance = modhel(mockOpenAIModelId);
      const outputBudget = mockOpenAIModelSpec.outputTokenLimit + 500;
      await instance.answer(prompt, { outputBudget });
      expect(mockResponsesCreate).toHaveBeenCalledWith(expect.objectContaining({ max_output_tokens: mockOpenAIModelSpec.outputTokenLimit }));
    });

    test('should call thirdpartyChatCompletion for DeepSeek provider', async () => {
      const instance = modhel(mockDeepSeekModelId);
      const response = await instance.answer(prompt);

      expect(common.getAPIKey).toHaveBeenCalledWith('DEEPSEEK_API_SK'); // Correct API key for DeepSeek
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith({
        model: mockDeepSeekModelSpec.model,
        temperature: 0,
        max_tokens: mockDeepSeekModelSpec.outputTokenLimit,
        messages: [{ role: 'user', content: prompt }],
      });
      expect(response).toEqual({
        output: 'Mocked OpenAI Chat Completions API response.',
        inputTokens: 12,
        outputTokens: 18,
        thinkingTokens: 0, // chat.completions.create doesn't provide reasoning_tokens in this mock
      });
    });

    test('should handle API errors gracefully (responses.create)', async () => {
      mockResponsesCreate.mockRejectedValue(new Error('OpenAI Responses API Error'));
      const instance = modhel(mockOpenAIModelId);
      await expect(instance.answer(prompt)).rejects.toThrow('OpenAI Responses API Error');
    });
  });

  describe('modhel("openai/...").completion()', () => {
    const prompt = 'Complete this for OpenAI.';

    test('should call answer internally (responses.create) and return text output', async () => {
      const instance = modhel(mockOpenAIModelId);
      const result = await instance.completion(prompt);
      expect(mockResponsesCreate).toHaveBeenCalled();
      expect(result).toBe('Mocked OpenAI Responses API response.');
    });

    test('should call answer internally (chat.completions.create for DeepSeek) and return text output', async () => {
      const instance = modhel(mockDeepSeekModelId);
      const result = await instance.completion(prompt);
      expect(mockChatCompletionsCreate).toHaveBeenCalled();
      expect(result).toBe('Mocked OpenAI Chat Completions API response.');
    });
  });

  describe('openaiSDK direct tests', () => {
    let sdk;
    const sdkDefaultConfig = { apiKey: 'sdk-test-key-direct' };

    beforeEach(() => {
      sdk = openaiSDK(sdkDefaultConfig, JSON.parse(JSON.stringify(mockCuratedModels)));
    });

    test('sdk.listModels() should call openai.models.list', async () => {
      const models = await sdk.listModels();
      expect(mockModelsList).toHaveBeenCalledTimes(1);
      expect(models.data).toEqual([{ id: 'gpt-4-turbo', name: 'GPT-4 Turbo Model' }]);
    });

    test('sdk.getModelInfo() should call openai.models.retrieve and translate', async () => {
      const modelInfo = await sdk.getModelInfo('gpt-4-turbo');
      expect(mockModelsRetrieve).toHaveBeenCalledWith('gpt-4-turbo');
      expect(modelInfo).toEqual({ model: 'gpt-4-turbo', name: 'GPT-4 Turbo Full Details', owned_by: 'openai' }); // id translated to model
    });

    test('sdk.completion() should call openai.chat.completions.create', async () => {
      const modelName = 'gpt-3.5-turbo'; // direct model name, not the full ID
      const result = await sdk.completion(modelName)(prompt);
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith({
        model: modelName,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      });
      expect(result).toBe('Mocked OpenAI Chat Completions API response.');
    });

    test('sdk.thirdpartyChatCompletion() should call openai.chat.completions.create with spec details', async () => {
      const budget = 100;
      const response = await sdk.thirdpartyChatCompletion(mockDeepSeekModelId) (prompt, { outputBudget: budget });
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith({
        model: mockDeepSeekModelSpec.model,
        temperature: 0,
        max_tokens: budget,
        messages: [{ role: 'user', content: prompt }],
      });
      expect(response.output).toBe('Mocked OpenAI Chat Completions API response.');
    });
    
    test('sdk.answer() should call openai.responses.create with all options', async () => {
        const options = {
            outputBudget: 500, outputEffort: 'low', outputType: 'json', 
            identifier: 'sdk-user', images: [{ data: 'imgdata', mimetype: 'image/jpeg' }]
        };
        await sdk.answer(mockOpenAIModelId)(prompt, options);
        expect(mockResponsesCreate).toHaveBeenCalledWith(expect.objectContaining({
            model: mockOpenAIModelSpec.model,
            input: expect.arrayContaining([
                expect.objectContaining({ type: 'input_text', text: prompt }),
                expect.objectContaining({ type: 'image_url', image_url: 'data:image/jpeg;base64,imgdata' })
            ]),
            max_output_tokens: options.outputBudget,
            reasoning: { effort: mockOpenAIModelSpec.thinkingEffortLevels[options.outputEffort] },
            text: { format: { type: 'json_object' } },
            user: options.identifier,
            store: false
        }));
    });
    
    test('sdk.answer can use a different OpenAI instance if configuration is passed', async () => {
        const runtimeConfig = { apiKey: 'runtime-key-openai', baseURL: 'http://localhost/custom' };
        const localMockResponsesCreate = vi.fn().mockResolvedValue({
             output: [{ type: 'message', content: [{ type: 'output_text', text: 'Local mock response' }] }],
             usage: { input_tokens: 1, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 } },
        });
        
        const OriginalOpenAIMock = vi.mocked(require('openai').default);
        OriginalOpenAIMock.mockImplementationOnce(() => ({
             responses: { create: localMockResponsesCreate },
             // Mock other parts of the client if they were to be used by this path
             chat: { completions: { create: vi.fn() } },
             models: { list: vi.fn(), retrieve: vi.fn() },
        }));

        await sdk.answer(mockOpenAIModelId, runtimeConfig)(prompt, {});
        
        expect(OriginalOpenAIMock).toHaveBeenCalledWith({ ...sdkDefaultConfig, ...runtimeConfig });
        expect(localMockResponsesCreate).toHaveBeenCalledWith(expect.objectContaining({
            model: mockOpenAIModelSpec.model,
        }));
        expect(mockResponsesCreate).not.toHaveBeenCalled(); 
    });

    describe('sdk.estimateImageTokens()', () => {
      const imageData = { mimetype: 'image/png', width: 1024, height: 1024, data: '...' };
      test.each([
        ['gpt-4.1-mini', imageData, 2048],
        ['gpt-4.1-nano', { ...imageData, mimetype: 'image/jpeg' }, 2048],
        ['gpt-4.1', { ...imageData, mimetype: 'image/webp' }, 2048],
        ['o4-mini', imageData, 1792],
        ['o3', imageData, 2304],
        ['o1-pro', imageData, 2560],
        ['gpt-4-turbo', imageData, Infinity], // Default case, not specifically listed in function
        ['gpt-4.1-mini', { ...imageData, mimetype: 'image/bmp' }, Infinity], // Unsupported type
      ])('should estimate tokens for model %s with mimetype %s as %i', (model, imgData, expectedTokens) => {
        expect(sdk.estimateImageTokens(model, imgData)).toBe(expectedTokens);
      });
    });
  });
});
