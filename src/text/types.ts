import { JSONSchemaType } from 'ajv';

import { AI } from './wrap';

export type GenerateTextExtraOptions = {
  sessionId?: string;
};

export type TextModelInfo = {
  name: string;
  currency: string;
  characterIsToken?: boolean;
  promptTokenCostPer1K: number;
  completionTokenCostPer1K: number;
  maxTokens?: number;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type GenerateTextModelConfig = {
  maxTokens: number;
  temperature: number;
  topP?: number;
  topK?: number;
  n?: number;
  stream?: boolean;
  logprobs?: number;
  echo?: boolean;
  presencePenalty?: number;
  frequencyPenalty?: number;
  bestOf?: number;
  logitBias?: Map<string, number>;
  suffix?: string | null;
};

export type FunctionExec = {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args?: any;
  result?: string;
  // reasoning?: string[];
};

export type GenerateTextResponse = {
  sessionId?: string;
  remoteId?: string;
  results: {
    text: string;
    id?: string;
    finishReason?: string;
  }[];
  modelUsage?: TokenUsage;
  embedModelUsage?: TokenUsage;
};

export type APIError = {
  message: string;
  status: number;
  header?: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
};

export type ParsingError = { message: string; value: string };

export type FuncTrace = { name: string; args: string; result?: string };

export type AIGenerateTextTraceStep = {
  traceId: string;
  sessionId?: string;
  request: {
    prompt: string;
    modelInfo: Readonly<TextModelInfo & { provider: string }>;
    modelConfig: Readonly<GenerateTextModelConfig>;
    embedModelInfo?: Readonly<TextModelInfo>;
  };
  response: Omit<GenerateTextResponse, 'sessionId'> & {
    modelResponseTime?: number;
    embedModelResponseTime?: number;
    functions?: FuncTrace[];
    parsingError?: ParsingError;
    apiError?: APIError;
  };
  createdAt: string;
};

// eslint-disable-next-line functional/no-mixed-types
export type AITextResponse<T> = {
  prompt: string;
  sessionId?: string;
  traces: AIGenerateTextTraceStep[];
  value(): T;
};

export type EmbedResponse = {
  remoteId?: string;
  sessionId?: string;
  texts: readonly string[];
  embedding: readonly number[];
  modelUsage?: TokenUsage;
};

export type TranscriptResponse = {
  sessionId?: string;
  duration: number;
  segments: {
    id: number;
    start: number;
    end: number;
    text: string;
  }[];
};

export interface AIMemory {
  add(text: string, sessionId?: string): void;
  history(sessionId?: string): string;
  peek(sessionId?: string): Readonly<string[]>;
  reset(sessionId?: string): void;
}

export type Embeddings = {
  model: string;
  embedding: number[];
};

export type PromptFunctionExtraOptions = {
  ai: Readonly<AI>;
  sessionId?: string;
};

export type PromptFunctionFunc = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args?: any,
  extra?: Readonly<PromptFunctionExtraOptions>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Promise<any>;

export type PromptFunction = {
  readonly name: string;
  readonly description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly inputSchema?: any;
  func: PromptFunctionFunc;
};

export type PromptResponseConfig<T> = {
  keyValue?: boolean;
  schema?: JSONSchemaType<T>;
};

export type PromptConfig<T> = AIPromptConfig & {
  queryPrefix?: string;
  responsePrefix?: string;
  functions?: PromptFunction[];
  response?: PromptResponseConfig<T>;
  debug?: boolean;
  log?: (traces: Readonly<AIGenerateTextTraceStep>) => void;
};

export type AIPromptConfig = {
  stopSequences: string[];
};

export interface AIService {
  name(): string;
  getModelInfo(): Readonly<TextModelInfo & { provider: string }>;
  getEmbedModelInfo(): Readonly<TextModelInfo> | undefined;
  getModelConfig(): Readonly<GenerateTextModelConfig>;
  generate(
    prompt: string,
    md?: Readonly<AIPromptConfig>,
    sessionId?: string
  ): Promise<GenerateTextResponse>;
  embed(
    text2Embed: readonly string[] | string,
    sessionId?: string
  ): Promise<EmbedResponse>;
  transcribe(
    file: string,
    prompt?: string,
    language?: string,
    sessionId?: string
  ): Promise<TranscriptResponse>;
}

/*
Magic isn't always unicorns and fairy dust␊
Sometimes it's computer code and technology that's quite a bit of work␊
But if you learn the tricks and the trades␊
You'll find there's a wonder that awaits␊

With a computer and some basic coding␊
You can make anything your heart desires␊
From games that you'll play for hours on end␊
To apps that will make life much more fun␊

So don't be afraid of the unknown␊
Embrace the magic of computer code␊
And you'll find that your dreams can come true␊
With just a little bit of coding, you can do anything too!
*/
