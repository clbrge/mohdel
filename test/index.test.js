import { describe, test, expect, vi, beforeEach } from 'vitest';
// Import the functions to be tested
import { expandModelAlias, getProviderAndModel } from '../src/index.js';

// Mock dependencies from '../src/common.js'
vi.mock('../src/common.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual, // Preserve other exports from common.js if any
    getCuratedModels: vi.fn(),
    getAPIKey: vi.fn(), // Mocked as it might be called by other functions, though not directly by the ones under test
    getDefaultModelId: vi.fn(), // Mocked for completeness
  };
});

// Import the mocked function to control its behavior in tests
import { getCuratedModels } from '../src/common.js';

describe('Index utility functions', () => {
  const mockCuratedModels = {
    'anthropic/claude-3-opus-20240229': { family: 'Claude 3', sdk: 'anthropic', label: 'Claude 3 Opus' },
    'anthropic/claude-3-sonnet-20240229': { family: 'Claude 3', sdk: 'anthropic', label: 'Claude 3 Sonnet' },
    'anthropic/claude-3-haiku-20240307': { family: 'Claude 3', sdk: 'anthropic', label: 'Claude 3 Haiku' },
    'openai/gpt-4-turbo': { sdk: 'openai', label: 'GPT-4 Turbo' },
    'openai/gpt-3.5-turbo': { sdk: 'openai', label: 'GPT-3.5 Turbo' },
    'gemini/gemini-1.5-pro-latest': { sdk: 'gemini', label: 'Gemini 1.5 Pro' },
    'custom/unique-model': { sdk: 'custom', label: 'Unique Model' }, // For testing unique model name resolution
    'another/unique-model-versioned-20240101': { sdk: 'another', label: 'Unique Model Versioned' }, // Another model that might cause ambiguity if not handled
  };

  beforeEach(() => {
    // Reset mocks before each test
    vi.resetAllMocks();
    // Setup getCuratedModels to return our mock data for each test
    getCuratedModels.mockResolvedValue(JSON.parse(JSON.stringify(mockCuratedModels))); // Deep copy to avoid modification issues
  });

  describe('expandModelAlias', () => {
    test('should return full model ID for a unique short alias (model name only)', async () => {
      // 'gemini-1.5-pro-latest' is unique in mockCuratedModels
      expect(await expandModelAlias('gemini-1.5-pro-latest')).toBe('gemini/gemini-1.5-pro-latest');
    });

    test('should return full model ID for a unique base name alias', async () => {
      // 'claude-3-haiku' should resolve to 'anthropic/claude-3-haiku-20240307'
      // as 'claude-3-haiku' is the base name of 'claude-3-haiku-20240307'
      expect(await expandModelAlias('claude-3-haiku')).toBe('anthropic/claude-3-haiku-20240307');
    });
    
    test('should return full model ID for an alias with provider prefix (base name)', async () => {
      expect(await expandModelAlias('anthropic/claude-3-sonnet')).toBe('anthropic/claude-3-sonnet-20240229');
    });

    test('should return original ID if it is already a full model ID present in curated models', async () => {
      expect(await expandModelAlias('anthropic/claude-3-opus-20240229')).toBe('anthropic/claude-3-opus-20240229');
    });

    test('should return original ID if no alias is found and not in curated (even if it looks like a full ID)', async () => {
      expect(await expandModelAlias('unknownprovider/model-123')).toBe('unknownprovider/model-123');
    });
    
    test('should return original ID if no alias is found (short name not in curated)', async () => {
      expect(await expandModelAlias('some-unlisted-model')).toBe('some-unlisted-model');
    });

    test('should handle model names that are unique and map to the correct full ID', async () => {
      // 'unique-model' is the model name for 'custom/unique-model'
      // buildAliasMap should identify 'unique-model' as unique if no other provider has just 'unique-model'
      expect(await expandModelAlias('unique-model')).toBe('custom/unique-model');
    });

    test('should correctly expand a versioned model name if its base is unique with provider', async () => {
        // 'another/unique-model-versioned' should resolve to 'another/unique-model-versioned-20240101'
        expect(await expandModelAlias('another/unique-model-versioned')).toBe('another/unique-model-versioned-20240101');
    });
  });

  describe('getProviderAndModel', () => {
    test('should extract provider and model from full ID', async () => {
      const result = await getProviderAndModel('anthropic/claude-3-opus-20240229');
      expect(result).toEqual({ providerName: 'anthropic', modelName: 'claude-3-opus-20240229' });
    });

    test('should resolve alias before extracting (unique short alias)', async () => {
      const result = await getProviderAndModel('gemini-1.5-pro-latest');
      expect(result).toEqual({ providerName: 'gemini', modelName: 'gemini-1.5-pro-latest' });
    });

    test('should resolve alias before extracting (unique base name alias)', async () => {
      const result = await getProviderAndModel('claude-3-haiku');
      expect(result).toEqual({ providerName: 'anthropic', modelName: 'claude-3-haiku-20240307' });
    });
    
    test('should resolve alias with provider prefix before extracting', async () => {
      const result = await getProviderAndModel('anthropic/claude-3-sonnet');
      expect(result).toEqual({ providerName: 'anthropic', modelName: 'claude-3-sonnet-20240229' });
    });

    test('should throw error for unknown provider', async () => {
      // 'unknownprovider' is not in providers.js (implicitly, as it's not 'anthropic', 'openai', etc.)
      await expect(getProviderAndModel('unknownprovider/model')).rejects.toThrow('Unknown provider: unknownprovider');
    });

    test('should throw error for model not in curated list (after alias expansion, known provider)', async () => {
      // 'anthropic' is a known provider, but 'nonexistent-model' is not in mockCuratedModels.
      await expect(getProviderAndModel('anthropic/nonexistent-model')).rejects.toThrow('Model anthropic/nonexistent-model is not in the curated list');
    });
    
    test('should handle model ID without provider if it uniquely identifies a model after alias expansion', async () => {
      const result = await getProviderAndModel('gemini-1.5-pro-latest'); // This is unique in mockCuratedModels
      expect(result).toEqual({ providerName: 'gemini', modelName: 'gemini-1.5-pro-latest' });
    });

    test('should throw error for ambiguous model name without provider', async () => {
        const ambiguousModelsData = {
            ...mockCuratedModels, // Use a fresh copy
            'providerA/common-name': { sdk: 'providerA', label: 'Common A' },
            'providerB/common-name': { sdk: 'providerB', label: 'Common B' },
        };
        getCuratedModels.mockResolvedValue(ambiguousModelsData);
        // 'common-name' by itself is now ambiguous.
        // The actual providers 'providerA' and 'providerB' need to exist in the real providers.js for this error to be about ambiguity
        // rather than "Unknown provider". Let's assume 'anthropic' and 'openai' are our "providerA" and "providerB" for this test's purpose
        // by adding models under them.
        const trulyAmbiguous = {
            'anthropic/claude-3-opus-20240229': { family: 'Claude 3', sdk: 'anthropic', label: 'Claude 3 Opus' },
            'openai/claude-3-opus-20240229': { sdk: 'openai', label: 'GPT-4 Turbo with same name' }, // Ambiguous name part
        }
         getCuratedModels.mockResolvedValue(trulyAmbiguous);
        await expect(getProviderAndModel('claude-3-opus-20240229')).rejects.toThrow(/Ambiguous model name "claude-3-opus-20240229" matches multiple models: anthropic\/claude-3-opus-20240229, openai\/claude-3-opus-20240229/);
    });


    test('should throw error if model ID is not a string', async () => {
        await expect(getProviderAndModel(123)).rejects.toThrow('Model ID must be a string');
    });

    test('should throw error if model ID is empty string', async () => {
        await expect(getProviderAndModel('')).rejects.toThrow('Model ID must be a string');
    });
    
    test('should throw error if model ID is null', async () => {
        await expect(getProviderAndModel(null)).rejects.toThrow('Model ID must be a string');
    });

  });
});
