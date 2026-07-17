/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Deploy-ready SST v3 config (deployment deferred — no AWS profile chosen yet;
 * set `profile` below or AWS_PROFILE before `sst deploy`).
 *
 * Architecture: StaticSite (Vite SPA) + Function API (artifacts + chat SSE via
 * Lambda response streaming) + Bucket (artifacts). Heavy analysis stays a CLI /
 * Fargate Task concern (see docs/superpowers/specs design doc) and is not
 * deployed in this first pass.
 */
export default $config({
  app(input) {
    return {
      name: "pr-rev",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      // providers: { aws: { profile: "personal" } },
    };
  },
  async run() {
    const artifacts = new sst.aws.Bucket("Artifacts");

    const api = new sst.aws.Function("Api", {
      handler: "packages/functions/src/lambda.handler",
      streaming: true,
      timeout: "120 seconds",
      link: [artifacts],
      environment: {
        ARTIFACTS_BUCKET: artifacts.name,
      },
      url: true,
    });

    const web = new sst.aws.StaticSite("Web", {
      path: "packages/web",
      build: {
        command: "pnpm build",
        output: "dist",
      },
      environment: {
        VITE_API_URL: api.url,
      },
    });

    return { web: web.url, api: api.url };
  },
});
