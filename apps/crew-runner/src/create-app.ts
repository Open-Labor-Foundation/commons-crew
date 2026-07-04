import Fastify from "fastify";
import { createApiProvider } from "../../../packages/provider-api/src/index";
import { loadConfigOrThrow, type AppConfig } from "../../../packages/config/src/index";
import { createAppServices } from "../../../packages/core/src/index";
import {
  CORRELATION_HEADER_NAMES,
  createStructuredLog,
  readCorrelationHeaders,
  resolveTraceId
} from "../../../packages/core/src/observability";

type RunnerProvider = ReturnType<typeof createApiProvider>;

export async function createRunnerApp({
  config = loadConfigOrThrow(),
  provider = createApiProvider(config)
}: {
  config?: AppConfig;
  provider?: RunnerProvider;
} = {}) {
  const app = Fastify({ logger: true });
  const services = await createAppServices(config, {
    provider,
    logger: app.log,
    serviceName: "crew-runner"
  });
  const runnerId = `pa-runner:${config.app.env}`;
  let drainTimer: NodeJS.Timeout | null = null;
  let draining = false;

  async function drainQueue() {
    if (draining) {
      return;
    }
    draining = true;

    try {
      while (true) {
        const job = await services.runner.claimNext(runnerId);
        if (!job) {
          return;
        }

        const started = await services.runner.start(job.id, runnerId);
        if (started && "error" in started) {
          app.log.warn(
            createStructuredLog(
              "crew-runner",
              "runner.job.start_conflict",
              {
                runId: job.runId,
                requestId: job.payload.requestId,
                traceId: job.payload.traceId
              },
              {
                jobId: job.id,
                runnerId,
                code: started.error.code
              }
            ),
            "runner.job.start_conflict"
          );
          return;
        }
      }
    } finally {
      draining = false;
    }
  }

  app.addHook("onRequest", async (request) => {
    const traceId = resolveTraceId(request.headers, request.id);
    request.log.info(
      createStructuredLog(
        "crew-runner",
        "http.request.received",
        {
          ...readCorrelationHeaders(request.headers),
          requestId: request.id,
          traceId
        },
        {
          method: request.method,
          url: request.url
        }
      ),
      "http.request.received"
    );
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(CORRELATION_HEADER_NAMES.traceId, resolveTraceId(request.headers, request.id));
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const traceId = resolveTraceId(request.headers, request.id);
    request.log.info(
      createStructuredLog(
        "crew-runner",
        "http.request.completed",
        {
          ...readCorrelationHeaders(request.headers),
          requestId: request.id,
          traceId
        },
        {
          method: request.method,
          route: request.routeOptions.url,
          statusCode: reply.statusCode
        }
      ),
      "http.request.completed"
    );
  });

  app.get("/health", async (request) => {
    request.log.info(
      createStructuredLog(
        "crew-runner",
        "runner.health.checked",
        {
          requestId: request.id,
          traceId: resolveTraceId(request.headers, request.id),
          ...readCorrelationHeaders(request.headers)
        },
        {
          storageMode: config.storage.mode
        }
      ),
      "runner.health.checked"
    );
    return {
      ok: true,
      service: "crew-runner",
      profile: config.profile.name,
      storageMode: config.storage.mode,
      stateFile: config.paths.stateFile,
      recoveryPolicy: "running work is re-queued and resumed after runner restart"
    };
  });

  app.get("/provider/status", async (request) => {
    const status = await services.provider.getStatus();
    request.log.info(
      createStructuredLog(
        "crew-runner",
        "provider.status.checked",
        {
          requestId: request.id,
          traceId: resolveTraceId(request.headers, request.id),
          ...readCorrelationHeaders(request.headers)
        },
        {
          providerId: status.id,
          installed: status.installed,
          authenticated: status.authenticated
        }
      ),
      "provider.status.checked"
    );
    return status;
  });

  app.get("/metrics", async () => await services.diagnostics.getMetrics());

  app.get("/diagnostics", async () => await services.diagnostics.getDiagnostics());

  app.get("/jobs", async () => ({
    jobs: await services.runner.list()
  }));

  app.addHook("onClose", async () => {
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }
    await services.shutdown();
  });

  drainTimer = setInterval(() => {
    void drainQueue();
  }, 250);
  void drainQueue();

  return app;
}
