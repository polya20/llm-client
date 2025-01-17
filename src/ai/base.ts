import chalk from 'chalk';

// import { ConsoleLogger } from '../logs/console.js';
import { RemoteLogger } from '../logs/remote.js';
import {
  AIPromptConfig,
  AIService,
  AIServiceActionOptions,
  AIServiceOptions
} from '../text/types.js';
import {
  AITextTraceStepBuilder,
  TextRequestBuilder,
  TextResponseBuilder
} from '../tracing/index.js';
import {
  AITextChatRequest,
  AITextCompletionRequest,
  AITextEmbedRequest,
  AITextTraceStep,
  TextModelInfoWithProvider
} from '../tracing/types.js';
import { API, apiCall } from '../util/apicall.js';
import { RespTransformStream } from '../util/transform.js';

import { MemoryCache } from './cache.js';
import {
  EmbedResponse,
  RateLimiterFunction,
  TextModelConfig,
  TextModelInfo,
  TextResponse
} from './types.js';
import {
  convertToChatRequest,
  convertToCompletionRequest,
  hashObject,
  mergeTextResponses,
  parseAndAddFunction
} from './util.js';

const cache = new MemoryCache<TextResponse>();

export class BaseAI<
  TCompletionRequest,
  TChatRequest,
  TEmbedRequest,
  TCompletionResponse,
  TCompletionResponseDelta,
  TChatResponse,
  TChatResponseDelta,
  TEmbedResponse
> implements AIService
{
  generateCompletionReq?: (
    req: Readonly<AITextCompletionRequest>,
    config: Readonly<AIPromptConfig>
  ) => [API, TCompletionRequest];
  generateChatReq?: (
    req: Readonly<AITextChatRequest>,
    config: Readonly<AIPromptConfig>
  ) => [API, TChatRequest];
  generateEmbedReq?: (req: Readonly<AITextChatRequest>) => [API, TEmbedRequest];
  generateCompletionResp?: (
    resp: Readonly<TCompletionResponse>
  ) => TextResponse;
  generateCompletionStreamResp?: (
    resp: Readonly<TCompletionResponseDelta>
  ) => TextResponse;
  generateChatResp?: (resp: Readonly<TChatResponse>) => TextResponse;
  generateChatStreamResp?: (resp: Readonly<TChatResponseDelta>) => TextResponse;
  generateEmbedResp?: (resp: Readonly<TEmbedResponse>) => EmbedResponse;

  // private consoleLog = new ConsoleLogger();
  private remoteLog = new RemoteLogger();
  private debug = false;
  private disableLog = false;

  private rt?: RateLimiterFunction;
  private log?: (traceStep: Readonly<AITextTraceStep>) => void;

  private traceStepBuilder?: AITextTraceStepBuilder;
  private traceStepReqBuilder?: TextRequestBuilder;
  private traceStepRespBuilder?: TextResponseBuilder;

  protected apiURL: string;
  protected aiName: string;
  protected headers: Record<string, string>;
  protected modelInfo: TextModelInfo;
  protected embedModelInfo?: TextModelInfo;

  constructor(
    aiName: string,
    apiURL: string,
    headers: Record<string, string>,
    modelInfo: Readonly<TextModelInfo[]>,
    models: Readonly<{ model: string; embedModel?: string }>,
    options: Readonly<AIServiceOptions> = {}
  ) {
    this.aiName = aiName;
    this.apiURL = apiURL;
    this.headers = headers;

    if (models.model.length === 0) {
      throw new Error('No model defined');
    }

    this.modelInfo = modelInfo.filter((v) => v.name === models.model).at(0) ?? {
      name: models.model,
      currency: 'usd',
      promptTokenCostPer1K: 0,
      completionTokenCostPer1K: 0
    };

    this.embedModelInfo = modelInfo
      .filter((v) => v.name === models.embedModel)
      .at(0);

    this.setOptions(options);

    if (this.debug) {
      this.remoteLog.printDebugInfo();
    }
  }

  setOptions(options: Readonly<AIServiceOptions>): void {
    if (options.debug) {
      this.debug = options.debug;
    }

    if (options.disableLog) {
      this.disableLog = options.disableLog;
    }

    if (options.log) {
      this.log = options.log;
    }

    if (options.rateLimiter) {
      this.rt = options.rateLimiter;
    }

    if (options.llmClientAPIKey) {
      this.remoteLog.setAPIKey(options.llmClientAPIKey);

      if (this.debug) {
        this.remoteLog.printDebugInfo();
      }
    }
  }

  getModelInfo(): Readonly<TextModelInfoWithProvider> {
    return { ...this.modelInfo, provider: this.aiName };
  }

  getEmbedModelInfo(): TextModelInfoWithProvider | undefined {
    return this.embedModelInfo
      ? { ...this.embedModelInfo, provider: this.aiName }
      : undefined;
  }

  name(): string {
    return this.aiName;
  }

  getModelConfig(): TextModelConfig {
    throw new Error('getModelConfig not implemented');
  }

  getTraceRequest(): Readonly<TextRequestBuilder> | undefined {
    return this.traceStepReqBuilder;
  }

  getTraceResponse(): Readonly<TextResponseBuilder> | undefined {
    return this.traceStepRespBuilder;
  }

  traceExists(): boolean {
    return (
      this.traceStepBuilder !== undefined &&
      this.traceStepReqBuilder !== undefined &&
      this.traceStepRespBuilder !== undefined
    );
  }

  async logTrace(): Promise<void> {
    if (
      !this.traceStepBuilder ||
      !this.traceStepReqBuilder ||
      !this.traceStepRespBuilder
    ) {
      throw new Error('Trace not initialized');
    }

    const traceStep = this.traceStepBuilder
      .setRequest(this.traceStepReqBuilder)
      .setResponse(this.traceStepRespBuilder)
      .build();

    if (this.remoteLog) {
      await this.remoteLog?.log?.(traceStep);
    }

    if (this.log) {
      this.log?.(traceStep);
    }

    // if (this.debug) {
    //   this.consoleLog.log(traceStep);
    // }
  }

  async completion(
    _req: Readonly<AITextCompletionRequest>,
    options: Readonly<AIPromptConfig & AIServiceActionOptions> = {
      stopSequences: []
    }
  ): Promise<TextResponse | ReadableStream<TextResponse>> {
    let hashKey: string | undefined;

    if (options.cache) {
      hashKey = hashObject(_req);
      const cached = await cache.get(hashKey);
      if (cached) {
        return cached;
      }
    }

    if (!this.generateCompletionReq && this.generateChatReq) {
      return await this.chat(convertToChatRequest(_req), options);
    }
    if (!this.generateCompletionReq) {
      throw new Error('generateCompletionReq not implemented');
    }
    if (!this.generateCompletionResp) {
      throw new Error('generateCompletionResp not implemented');
    }

    let startTime = 0;

    const reqFn = this.generateCompletionReq;
    const stream = options.stream ?? _req.modelConfig?.stream;
    const req = {
      ..._req,
      modelConfig: { ..._req.modelConfig, stream }
    } as Readonly<AITextChatRequest>;

    const fn = async () => {
      startTime = new Date().getTime();
      const [apiConfig, reqValue] = reqFn(req, options as AIPromptConfig);

      const res = await apiCall(
        {
          name: apiConfig.name,
          url: this.apiURL,
          headers: this.buildHeaders(apiConfig.headers)
        },
        reqValue
      );
      return res;
    };

    this.setStep(options);
    this.traceStepReqBuilder = new TextRequestBuilder().setCompletionStep(
      req,
      this.getModelConfig(),
      this.getEmbedModelInfo()
    );

    if (this.debug) {
      logCompletionRequest(req);
    }

    const rv = this.rt ? await this.rt(fn) : await fn();

    if (stream) {
      if (!this.generateCompletionStreamResp) {
        throw new Error('generateCompletionStreamResp not implemented');
      }

      const respFn = this.generateCompletionStreamResp;
      const wrappedRespFn = (resp: Readonly<TCompletionResponseDelta>) => {
        const res = respFn(resp);
        res.sessionId = options?.sessionId;
        return res;
      };

      const doneCb = async (values: readonly TextResponse[]) => {
        const res = mergeTextResponses(values);
        if (req.functions) {
          parseAndAddFunction(req.functions, res);
        }
        await this.setStepTextResponse(res, startTime);

        if (options.cache && hashKey) {
          cache.set(hashKey, res, options.cacheMaxAgeSeconds ?? 3600);
        }
      };

      const st = (rv as ReadableStream<TCompletionResponseDelta>).pipeThrough(
        new RespTransformStream<TCompletionResponseDelta, TextResponse>(
          wrappedRespFn,
          doneCb
        )
      );
      return st;
    }

    if (!this.generateCompletionResp) {
      throw new Error('generateCompletionResp not implemented');
    }

    const res = this.generateCompletionResp(rv as TCompletionResponse);
    if (req.functions) {
      parseAndAddFunction(req.functions, res);
    }

    await this.setStepTextResponse(res, new Date().getTime() - startTime);
    res.sessionId = options?.sessionId;

    if (options.cache && hashKey) {
      cache.set(hashKey, res, options.cacheMaxAgeSeconds ?? 3600);
    }
    return res;
  }

  async chat(
    _req: Readonly<AITextChatRequest>,
    options: Readonly<AIPromptConfig & AIServiceActionOptions> = {
      stopSequences: []
    }
  ): Promise<TextResponse | ReadableStream<TextResponse>> {
    let hashKey: string | undefined;

    if (options.cache) {
      hashKey = hashObject(_req);
      const cached = await cache.get(hashKey);
      if (cached) {
        return cached;
      }
    }

    if (!this.generateChatReq && this.generateCompletionReq) {
      return await this.completion(convertToCompletionRequest(_req), options);
    }
    if (!this.generateChatReq) {
      throw new Error('generateChatReq not implemented');
    }

    let startTime = 0;

    const reqFn = this.generateChatReq;
    const stream = options.stream ?? _req.modelConfig?.stream;
    const req = {
      ..._req,
      modelConfig: { ..._req.modelConfig, stream }
    } as Readonly<AITextChatRequest>;

    const fn = async () => {
      startTime = new Date().getTime();
      const [apiConfig, reqValue] = reqFn(req, options as AIPromptConfig);

      const res = await apiCall(
        {
          name: apiConfig.name,
          url: this.apiURL,
          headers: this.buildHeaders(apiConfig.headers),
          stream
        },
        reqValue
      );
      return res;
    };

    this.setStep(options);
    this.traceStepReqBuilder = new TextRequestBuilder().setChatStep(
      req,
      this.getModelConfig(),
      this.getModelInfo()
    );

    if (this.debug) {
      logChatRequest(req);
    }

    const rv = this.rt ? await this.rt(fn) : await fn();

    if (stream) {
      if (!this.generateChatStreamResp) {
        throw new Error('generateChatResp not implemented');
      }

      const respFn = this.generateChatStreamResp;
      const wrappedRespFn = (resp: Readonly<TChatResponseDelta>) => {
        const res = respFn(resp);
        res.sessionId = options?.sessionId;
        return res;
      };

      const doneCb = async (values: readonly TextResponse[]) => {
        const res = mergeTextResponses(values);
        if (req.functions) {
          parseAndAddFunction(req.functions, res);
        }
        await this.setStepTextResponse(res, startTime);
        if (options.cache && hashKey) {
          cache.set(hashKey, res, options.cacheMaxAgeSeconds ?? 3600);
        }
      };

      const st = (rv as ReadableStream<TChatResponseDelta>).pipeThrough(
        new RespTransformStream<TChatResponseDelta, TextResponse>(
          wrappedRespFn,
          doneCb
        )
      );
      return st;
    }

    if (!this.generateChatResp) {
      throw new Error('generateChatResp not implemented');
    }
    const res = this.generateChatResp(rv as TChatResponse);
    if (req.functions) {
      parseAndAddFunction(req.functions, res);
    }

    await this.setStepTextResponse(res, new Date().getTime() - startTime);
    res.sessionId = options?.sessionId;

    if (options.cache && hashKey) {
      cache.set(hashKey, res, options.cacheMaxAgeSeconds ?? 3600);
    }
    return res;
  }

  async embed(
    req: Readonly<AITextEmbedRequest>,
    options?: Readonly<AIServiceActionOptions>
  ): Promise<EmbedResponse> {
    let modelResponseTime;

    if (!this.generateEmbedReq) {
      throw new Error('generateEmbedReq not implemented');
    }
    if (!this.generateEmbedResp) {
      throw new Error('generateEmbedResp not implemented');
    }

    const fn = async () => {
      const st = new Date().getTime();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const [apiConfig, reqValue] = this.generateEmbedReq!(req);
      const res = await apiCall(
        {
          name: apiConfig.name,
          url: this.apiURL,
          headers: this.buildHeaders(apiConfig.headers)
        },
        reqValue
      );
      modelResponseTime = new Date().getTime() - st;
      return res;
    };

    this.setStep(options);
    this.traceStepReqBuilder = new TextRequestBuilder().setEmbedStep(
      req,
      this.getEmbedModelInfo()
    );

    const resValue = this.rt ? await this.rt(async () => fn()) : await fn();

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const res = this.generateEmbedResp!(resValue as TEmbedResponse);

    this.traceStepRespBuilder = new TextResponseBuilder()
      .setModelUsage(res.modelUsage)
      .setModelResponseTime(modelResponseTime);

    res.sessionId = options?.sessionId;
    return res;
  }

  // async _transcribe(
  //   // eslint-disable-next-line @typescript-eslint/no-unused-vars
  //   _file: string,
  //   // eslint-disable-next-line @typescript-eslint/no-unused-vars
  //   _prompt?: string,
  //   // eslint-disable-next-line @typescript-eslint/no-unused-vars
  //   _options?: Readonly<AITranscribeConfig & AIServiceActionOptions>
  // ): Promise<TranscriptResponse> {
  //   throw new Error('_transcribe not implemented');
  // }

  // async transcribe(
  //   file: string,
  //   prompt?: string,
  //   options?: Readonly<AITranscribeConfig & AIServiceActionOptions>
  // ): Promise<TranscriptResponse> {
  //   const res = this.rt
  //     ? await this.rt<Promise<TranscriptResponse>>(
  //         async () => await this._transcribe(file, prompt, options)
  //       )
  //     : await this._transcribe(file, prompt, options);

  //   res.sessionId = options?.sessionId;
  //   return res;
  // }

  // async apiCallWithUpload<Request, Response, APIType extends API >(
  //   api: APIType,
  //   json: Request,
  //   file: string
  // ): Promise<Response> {
  // return apiCallWithUpload<Request, Response, APIType>(this.mergeAPIConfig<APIType>(api), json, file);
  // }

  setStep(options?: Readonly<AIServiceActionOptions>) {
    this.traceStepBuilder = new AITextTraceStepBuilder()
      .setTraceId(options?.traceId)
      .setSessionId(options?.sessionId);
  }

  async setStepTextResponse(res: Readonly<TextResponse>, startTime: number) {
    if (this.debug) {
      logResponse(res as TextResponse);
    }

    this.traceStepRespBuilder = new TextResponseBuilder()
      .setResults(res.results)
      .setModelUsage(res.modelUsage)
      .setModelResponseTime(new Date().getTime() - startTime);

    if (!this.disableLog) {
      await this.logTrace();
    }
  }

  private buildHeaders(
    headers: Record<string, string> = {}
  ): Record<string, string> {
    return { ...headers, ...this.headers };
  }
}

const logCompletionRequest = (req: Readonly<AITextCompletionRequest>) => {
  console.log(chalk.whiteBright('Request:'));
  console.log(
    `${chalk.blueBright('system')}: ${req.systemPrompt}\n${chalk.blueBright(
      'prompt'
    )}: ${req.prompt}`
  );
  if (req.functions) {
    console.log(
      `${chalk.blueBright('functions')}: ${JSON.stringify(
        req.functions,
        null,
        2
      )}`
    );
  }
};

const logChatRequest = (req: Readonly<AITextChatRequest>) => {
  console.log(chalk.whiteBright('Request: '));
  const items =
    req.chatPrompt?.map(
      (v) => `${chalk.blueBright('> ' + v.role)}: ${v.text}`
    ) ?? [];
  console.log(items.join('\n'));
  if (req.functions) {
    console.log(
      `${chalk.blueBright('functions')}: ${JSON.stringify(
        req.functions,
        null,
        2
      )}`
    );
  }
};

const logResponse = (res: Readonly<TextResponse>) => {
  console.log(chalk.whiteBright('Response:'));
  const prefix = res.results.length > 1 ? '> ' : '';
  console.log(
    chalk.green(res.results.map((v) => `${prefix}${v.text}`).join('\n')),
    '\n---\n\n'
  );
};
