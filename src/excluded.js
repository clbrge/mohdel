const excluded = {
  "anthropic/claude-3-5-sonnet-20241022": {
    "label": "Claude 3.5 Sonnet (New)"
  },
  "anthropic/claude-2.0": {
    "label": "Claude 2.0"
  },
  "anthropic/claude-3-5-sonnet-20240620": {
    "label": "Claude 3.5 Sonnet (Old)"
  },
  "anthropic/claude-3-haiku-20240307": {
    "label": "Claude 3 Haiku"
  },
  "anthropic/claude-3-opus-20240229": {
    "label": "Claude 3 Opus"
  },
  "anthropic/claude-3-sonnet-20240229": {
    "label": "Claude 3 Sonnet"
  },
  "anthropic/claude-2.1": {
    "label": "Claude 2.1"
  },
  "gemini/chat-bison-001": {
    "label": "PaLM 2 Chat (Legacy)"
  },
  "gemini/text-bison-001": {
    "label": "PaLM 2 (Legacy)"
  },
  "gemini/embedding-gecko-001": {
    "label": "Embedding Gecko"
  },
  "gemini/gemini-1.0-pro-vision-latest": {
    "label": "Gemini 1.0 Pro Vision"
  },
  "gemini/gemini-pro-vision": {
    "label": "Gemini 1.0 Pro Vision"
  },
  "gemini/gemini-1.5-pro-001": {
    "label": "Gemini 1.5 Pro 001"
  },
  "gemini/gemini-1.5-pro-002": {
    "label": "Gemini 1.5 Pro 002"
  },
  "gemini/gemini-1.5-pro": {
    "label": "Gemini 1.5 Pro"
  },
  "gemini/gemini-1.5-flash-latest": {
    "label": "Gemini 1.5 Flash Latest"
  },
  "gemini/gemini-1.5-flash-001": {
    "label": "Gemini 1.5 Flash 001"
  },
  "gemini/gemini-1.5-flash-001-tuning": {
    "label": "Gemini 1.5 Flash 001 Tuning"
  },
  "gemini/gemini-1.5-flash": {
    "label": "Gemini 1.5 Flash"
  },
  "gemini/gemini-1.5-flash-002": {
    "label": "Gemini 1.5 Flash 002"
  },
  "gemini/gemini-1.5-flash-8b": {
    "label": "Gemini 1.5 Flash-8B"
  },
  "gemini/gemini-1.5-flash-8b-001": {
    "label": "Gemini 1.5 Flash-8B 001"
  },
  "gemini/gemini-1.5-flash-8b-latest": {
    "label": "Gemini 1.5 Flash-8B Latest"
  },
  "gemini/gemini-1.5-flash-8b-exp-0827": {
    "label": "Gemini 1.5 Flash 8B Experimental 0827"
  },
  "gemini/gemini-1.5-flash-8b-exp-0924": {
    "label": "Gemini 1.5 Flash 8B Experimental 0924"
  },
  "gemini/gemini-2.0-pro-exp": {
    "label": "Gemini 2.0 Pro Experimental"
  },
  "gemini/gemini-2.0-pro-exp-02-05": {
    "label": "Gemini 2.0 Pro Experimental 02-05"
  },
  "gemini/learnlm-1.5-pro-experimental": {
    "label": "LearnLM 1.5 Pro Experimental"
  },
  "gemini/gemma-3-27b-it": {
    "label": "Gemma 3 27B"
  },
  "gemini/embedding-001": {
    "label": "Embedding 001"
  },
  "gemini/text-embedding-004": {
    "label": "Text Embedding 004"
  },
  "gemini/gemini-embedding-exp-03-07": {
    "label": "Gemini Embedding Experimental 03-07"
  },
  "gemini/gemini-embedding-exp": {
    "label": "Gemini Embedding Experimental"
  },
  "gemini/aqa": {
    "label": "Model that performs Attributed Question Answering."
  },
  "gemini/imagen-3.0-generate-002": {
    "label": "Imagen 3.0 002 model"
  },
  "gemini/gemini-2.5-pro-exp-03-25": {
    "label": "Gemini 2.5 Pro Experimental 03-25"
  },
  "gemini/gemma-3-1b-it": {
    "label": "Gemma 3 1B"
  },
  "gemini/gemma-3-4b-it": {
    "label": "Gemma 3 4B"
  },
  "gemini/gemma-3-12b-it": {
    "label": "Gemma 3 12B"
  },
  "gemini/veo-2.0-generate-001": {
    "label": "Veo 2"
  },
  "openai/gpt-4o-audio-preview-2024-12-17": {
    "label": "gpt-4o-audio-preview-2024-12-17"
  },
  "openai/dall-e-3": {
    "label": "dall-e-3"
  },
  "openai/dall-e-2": {
    "label": "dall-e-2"
  },
  "openai/gpt-4o-audio-preview-2024-10-01": {
    "label": "gpt-4o-audio-preview-2024-10-01"
  },
  "openai/gpt-4o-realtime-preview-2024-10-01": {
    "label": "gpt-4o-realtime-preview-2024-10-01"
  },
  "openai/gpt-4o-realtime-preview": {
    "label": "gpt-4o-realtime-preview"
  },
  "openai/babbage-002": {
    "label": "babbage-002"
  },
  "openai/tts-1-hd-1106": {
    "label": "tts-1-hd-1106"
  },
  "openai/text-embedding-3-large": {
    "label": "text-embedding-3-large"
  },
  "openai/text-embedding-ada-002": {
    "label": "text-embedding-ada-002"
  },
  "openai/tts-1-hd": {
    "label": "tts-1-hd"
  },
  "openai/gpt-4-0125-preview": {
    "label": "gpt-4-0125-preview"
  },
  "openai/gpt-4o-mini-audio-preview": {
    "label": "gpt-4o-mini-audio-preview"
  },
  "openai/gpt-4-turbo-preview": {
    "label": "gpt-4-turbo-preview"
  },
  "openai/gpt-4o-audio-preview": {
    "label": "gpt-4o-audio-preview"
  },
  "openai/gpt-4o-mini-realtime-preview": {
    "label": "gpt-4o-mini-realtime-preview"
  },
  "openai/gpt-4o-mini-realtime-preview-2024-12-17": {
    "label": "gpt-4o-mini-realtime-preview-2024-12-17"
  },
  "openai/gpt-3.5-turbo-instruct-0914": {
    "label": "gpt-3.5-turbo-instruct-0914"
  },
  "openai/gpt-4o-mini-search-preview": {
    "label": "gpt-4o-mini-search-preview"
  },
  "openai/tts-1-1106": {
    "label": "tts-1-1106"
  },
  "openai/davinci-002": {
    "label": "davinci-002"
  },
  "openai/gpt-3.5-turbo-1106": {
    "label": "gpt-3.5-turbo-1106"
  },
  "openai/gpt-4o-search-preview": {
    "label": "gpt-4o-search-preview"
  },
  "openai/gpt-4-turbo": {
    "label": "gpt-4-turbo"
  },
  "openai/gpt-4o-realtime-preview-2024-12-17": {
    "label": "gpt-4o-realtime-preview-2024-12-17"
  },
  "openai/gpt-3.5-turbo-instruct": {
    "label": "gpt-3.5-turbo-instruct"
  },
  "openai/gpt-3.5-turbo": {
    "label": "gpt-3.5-turbo"
  },
  "openai/gpt-4o-mini-search-preview-2025-03-11": {
    "label": "gpt-4o-mini-search-preview-2025-03-11"
  },
  "openai/gpt-4o-2024-11-20": {
    "label": "gpt-4o-2024-11-20"
  },
  "openai/whisper-1": {
    "label": "whisper-1"
  },
  "openai/gpt-4-turbo-2024-04-09": {
    "label": "gpt-4-turbo-2024-04-09"
  },
  "openai/gpt-3.5-turbo-16k": {
    "label": "gpt-3.5-turbo-16k"
  },
  "openai/gpt-4-1106-preview": {
    "label": "gpt-4-1106-preview"
  },
  "openai/gpt-4.5-preview-2025-02-27": {
    "label": "gpt-4.5-preview-2025-02-27"
  },
  "openai/gpt-4o-search-preview-2025-03-11": {
    "label": "gpt-4o-search-preview-2025-03-11"
  },
  "openai/computer-use-preview": {
    "label": "computer-use-preview"
  },
  "openai/tts-1": {
    "label": "tts-1"
  },
  "openai/omni-moderation-2024-09-26": {
    "label": "omni-moderation-2024-09-26"
  },
  "openai/text-embedding-3-small": {
    "label": "text-embedding-3-small"
  },
  "openai/gpt-4o-mini-tts": {
    "label": "gpt-4o-mini-tts"
  },
  "openai/gpt-4o-2024-08-06": {
    "label": "gpt-4o-2024-08-06"
  },
  "openai/gpt-4o-transcribe": {
    "label": "gpt-4o-transcribe"
  },
  "openai/gpt-4o-mini-2024-07-18": {
    "label": "gpt-4o-mini-2024-07-18"
  },
  "openai/gpt-4o-mini-transcribe": {
    "label": "gpt-4o-mini-transcribe"
  },
  "openai/gpt-4o-mini-audio-preview-2024-12-17": {
    "label": "gpt-4o-mini-audio-preview-2024-12-17"
  },
  "openai/gpt-3.5-turbo-0125": {
    "label": "gpt-3.5-turbo-0125"
  },
  "openai/o1-mini-2024-09-12": {
    "label": "o1-mini-2024-09-12"
  },
  "openai/computer-use-preview-2025-03-11": {
    "label": "computer-use-preview-2025-03-11"
  },
  "openai/omni-moderation-latest": {
    "label": "omni-moderation-latest"
  }
}

export default excluded
