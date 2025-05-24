import { describe, test, expect, vi, beforeEach } from 'vitest';
import modhel from '../src/index.js';
import geminiSDK from '../src/sdk/gemini.js'; // For testing the SDK directly
import * as common from '../src/common.js'; // To mock its functions

// Mock @google/genai
const mockGenerateContent = vi.fn();
const mockGetModel = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContent: mockGenerateContent,
      get: mockGetModel,
    },
  })),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock src/common.js
vi.mock('../src/common.js', async (importOriginal) => {
  const actual = await importOriginal() || {}; // Ensure actual is an object
  return {
    ...actual,
    getAPIKey: vi.fn(),
    getCuratedModels: vi.fn(),
    getDefaultModelId: vi.fn(),
  };
});

const mockGeminiModelId = 'gemini/gemini-1.5-pro-latest';
const mockGeminiModelSpec = {
  model: 'models/gemini-1.5-pro-latest', // Actual model name for the API
  outputTokenLimit: 8192,
  sdk: 'gemini',
  label: 'Gemini 1.5 Pro Latest',
  thinkingEffortLevels: { low: 100, medium: 500, high: 2000 }, // Example effort levels
};
const mockAnotherGeminiModelId = 'gemini/gemini-flash-latest';
const mockAnotherGeminiModelSpec = {
  model: 'models/gemini-flash-latest',
  outputTokenLimit: 4096,
  sdk: 'gemini',
  label: 'Gemini Flash Latest',
};

const mockCuratedModels = {
  [mockGeminiModelId]: mockGeminiModelSpec,
  [mockAnotherGeminiModelId]: mockAnotherGeminiModelSpec,
  'openai/gpt-4': { model: 'gpt-4', outputTokenLimit: 8000, sdk: 'openai' } // Other provider for completeness
};

const outputStyleTemperature = { // Copied from gemini.js for test reference
  coding: 0.0,
  analysis: 0.2,
  translation: 0.4,
  chat: 0.9,
  creative: 1.0
};

describe('Gemini Provider', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Setup default mocks for common.js functions
    common.getAPIKey.mockReturnValue('test-gemini-api-key');
    common.getCuratedModels.mockResolvedValue(JSON.parse(JSON.stringify(mockCuratedModels)));

    // Default successful response for Gemini API calls
    mockGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'Mocked Gemini response text.' }] } }],
      usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 30, thoughtsTokenCount: 5 },
    });
    mockGetModel.mockResolvedValue({
      name: 'models/gemini-1.5-pro-latest',
      displayName: 'Gemini 1.5 Pro',
      version: 'v1',
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'models/gemini-pro', displayName: 'Gemini Pro Base' }] }),
    });
  });

  describe('modhel("gemini/...").answer()', () => {
    const prompt = 'Hello, Gemini!';

    test('should call gemini.models.generateContent with correct parameters and return formatted response', async () => {
      const instance = modhel(mockGeminiModelId);
      const response = await instance.answer(prompt, { outputStyle: 'chat' }); // Default options

      expect(common.getAPIKey).toHaveBeenCalledWith('GEMINI_API_SK');
      expect(mockGenerateContent).toHaveBeenCalledWith({
        model: mockGeminiModelSpec.model,
        contents: prompt,
        config: {
          maxOutputTokens: mockGeminiModelSpec.outputTokenLimit, // Default budget
          temperature: outputStyleTemperature.chat, // From options.outputStyle
          // thinkingConfig not included if outputEffort not specified or 'none'
        },
      });
      expect(response).toEqual({
        output: 'Mocked Gemini response text.',
        inputTokens: 15,
        outputTokens: 30,
        thinkingTokens: 5,
      });
    });

    test('should respect options.outputBudget for maxOutputTokens', async () => {
      const instance = modhel(mockGeminiModelId);
      const outputBudget = 1000;
      await instance.answer(prompt, { outputBudget, outputStyle: 'analysis' });

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ maxOutputTokens: outputBudget, temperature: outputStyleTemperature.analysis }),
        })
      );
    });
    
    test('should cap options.outputBudget at model`s outputTokenLimit', async () => {
      const instance = modhel(mockGeminiModelId);
      const outputBudget = mockGeminiModelSpec.outputTokenLimit + 500; // Exceeds limit
      await instance.answer(prompt, { outputBudget, outputStyle: 'creative' });

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ maxOutputTokens: mockGeminiModelSpec.outputTokenLimit, temperature: outputStyleTemperature.creative }),
        })
      );
    });

    test('should include thinkingConfig if options.outputEffort is provided and valid', async () => {
      const instance = modhel(mockGeminiModelId);
      const outputEffort = 'low';
      await instance.answer(prompt, { outputStyle: 'coding', outputEffort });

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            temperature: outputStyleTemperature.coding,
            thinkingConfig: { thinkingBudget: mockGeminiModelSpec.thinkingEffortLevels[outputEffort] },
          }),
        })
      );
    });
    
    test('should NOT include thinkingConfig if options.outputEffort is "none" or invalid', async () => {
      const instance = modhel(mockGeminiModelId);
      await instance.answer(prompt, { outputStyle: 'coding', outputEffort: 'none' });
      expect(mockGenerateContent.mock.calls[0][0].config.thinkingConfig).toBeUndefined();

      mockGenerateContent.mockClear();
      await instance.answer(prompt, { outputStyle: 'coding', outputEffort: 'invalid_effort' });
      expect(mockGenerateContent.mock.calls[0][0].config.thinkingConfig).toBeUndefined();
    });


    test('should handle API errors gracefully', async () => {
      const apiError = new Error('Gemini API Error');
      mockGenerateContent.mockRejectedValue(apiError);
      const instance = modhel(mockGeminiModelId);

      await expect(instance.answer(prompt, {})).rejects.toThrow(apiError);
    });
  });

  describe('modhel("gemini/...").completion()', () => {
    const prompt = 'Complete this for Gemini.';

    test('should call answer internally and return just the text output', async () => {
      const instance = modhel(mockGeminiModelId);
      const result = await instance.completion(prompt); // Default options

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({ contents: prompt })
      );
      expect(result).toBe('Mocked Gemini response text.');
    });

    test('should handle errors from internal answer call', async () => {
      const apiError = new Error('Gemini API Error from completion');
      mockGenerateContent.mockRejectedValue(apiError);
      const instance = modhel(mockGeminiModelId);

      await expect(instance.completion(prompt)).rejects.toThrow(apiError);
    });
  });

  describe('geminiSDK direct tests', () => {
    let sdk;
    const sdkDefaultConfig = { apiKey: 'sdk-test-key-direct' };
    // Specs are passed to the SDK constructor but not directly used by listModels or getModelInfo
    // They are used by the SDK's `answer` method.
    const sdkSpecs = { 
        [mockGeminiModelId]: mockGeminiModelSpec,
        [mockAnotherGeminiModelId]: mockAnotherGeminiModelSpec
    };

    beforeEach(() => {
      sdk = geminiSDK(sdkDefaultConfig, sdkSpecs);
    });

    describe('sdk.listModels()', () => {
      test('should call fetch with correct URL and return formatted models', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ models: [
            { name: 'models/gemini-1.5-pro-latest', displayName: 'Gemini 1.5 Pro', version: "001" },
            { name: 'models/gemini-flash', displayName: 'Gemini Flash', version: "001" },
          ]}),
        });
        const models = await sdk.listModels();
        expect(mockFetch).toHaveBeenCalledWith(`https://generativelanguage.googleapis.com/v1beta/models?key=${sdkDefaultConfig.apiKey}`);
        expect(models).toEqual([
          { id: 'gemini-1.5-pro-latest', label: 'Gemini 1.5 Pro', name: 'models/gemini-1.5-pro-latest', displayName: 'Gemini 1.5 Pro', version: "001" },
          { id: 'gemini-flash', label: 'Gemini Flash', name: 'models/gemini-flash', displayName: 'Gemini Flash', version: "001" },
        ]);
      });

      test('should return empty models array on fetch network error', async () => {
        mockFetch.mockRejectedValue(new Error('Network error'));
        const models = await sdk.listModels();
        expect(models).toEqual({ models: [] }); // As per current implementation
      });

      test('should return empty models array on non-ok fetch response', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
        const models = await sdk.listModels();
        expect(models).toEqual({ models: [] }); // As per current implementation
      });
    });

    describe('sdk.getModelInfo()', () => {
      const modelShortName = 'gemini-1.5-pro-latest'; // SDK expects short name
      const modelApiName = 'models/gemini-1.5-pro-latest'; // API needs this format

      test('should call gemini.models.get with prefixed model name and return translated info', async () => {
        mockGetModel.mockResolvedValue({
          name: modelApiName,
          displayName: 'Gemini 1.5 Pro Display',
          description: 'Test model',
          version: '001-test',
        });
        const modelInfo = await sdk.getModelInfo(modelShortName);
        expect(mockGetModel).toHaveBeenCalledWith({ model: modelApiName }); // Check it's called with the object structure
        expect(modelInfo).toEqual({
          model: modelShortName, // Translated from 'name'
          displayName: 'Gemini 1.5 Pro Display',
          description: 'Test model',
          version: '001-test',
        });
      });

      test('should throw error on API error during getModelInfo', async () => {
        const getError = new Error('Get model API error');
        mockGetModel.mockRejectedValue(getError);
        // The SDK's getModelInfo catches the error and re-throws it.
        await expect(sdk.getModelInfo(modelShortName)).rejects.toThrow(getError);
      });
    });
    
    describe('sdk.answer() (direct SDK method)', () => {
        const prompt = 'SDK direct answer for Gemini';
        
        test('should call gemini.models.generateContent with correct parameters', async () => {
            const sdkInstance = geminiSDK(sdkDefaultConfig, sdkSpecs); // sdkSpecs contains mockGeminiModelId
            const options = { outputBudget: 100, outputStyle: 'chat', outputEffort: 'low' };
            await sdkInstance.answer(mockGeminiModelId)(prompt, options);

            expect(mockGenerateContent).toHaveBeenCalledWith({
                model: mockGeminiModelSpec.model, // From sdkSpecs
                contents: prompt,
                config: {
                    maxOutputTokens: options.outputBudget,
                    temperature: outputStyleTemperature[options.outputStyle],
                    thinkingConfig: { thinkingBudget: mockGeminiModelSpec.thinkingEffortLevels[options.outputEffort] }
                }
            });
        });

        test('sdk.answer should use default outputTokenLimit if outputBudget is not set', async () => {
            const sdkInstance = geminiSDK(sdkDefaultConfig, sdkSpecs);
            await sdkInstance.answer(mockGeminiModelId)(prompt, { outputStyle: 'coding' });
            
            expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
                config: expect.objectContaining({ maxOutputTokens: mockGeminiModelSpec.outputTokenLimit })
            }));
        });
        
        test('sdk.answer can use a different GoogleGenAI instance if configuration is passed', async () => {
            const sdkInstance = geminiSDK(sdkDefaultConfig, sdkSpecs);
            const runtimeConfig = { apiKey: 'runtime-key-gemini' }; // Gemini takes apiKey directly
            const localMockGenerateContent = vi.fn().mockResolvedValue({
                 candidates: [{ content: { parts: [{ text: 'Local mock response' }] } }],
                 usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 0 },
            });
            
            const OriginalGoogleGenAIMock = vi.mocked(require('@google/genai').GoogleGenAI);
            OriginalGoogleGenAIMock.mockImplementationOnce(() => ({
                 models: { generateContent: localMockGenerateContent, get: vi.fn() },
            }));

            await sdkInstance.answer(mockGeminiModelId, runtimeConfig)(prompt, {});
            
            expect(OriginalGoogleGenAIMock).toHaveBeenCalledWith({ ...sdkDefaultConfig, ...runtimeConfig });
            expect(localMockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
                model: mockGeminiModelSpec.model,
            }));
            expect(mockGenerateContent).not.toHaveBeenCalled(); 
        });
    });
  });
});
