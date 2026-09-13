import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// useWorkerdCondition: false — by default OpenNext bundles with esbuild's
// "workerd" export condition, which resolves packages that declare it
// (@sentry/nextjs, uncrypto, node-fetch-native, …) to edge/web builds that
// Next's file trace (node/require conditions) never copied, so the bundle
// fails with "Could not resolve". With the flag esbuild resolves the same
// files the trace copied. This is the escape hatch OpenNext documents for
// exactly this mismatch (see @opennextjs/cloudflare bundle-server.js).
export default {
  ...defineCloudflareConfig({
    default: {
      override: {
        wrapper: "cloudflare-node",
      },
    },
  }),
  cloudflare: { useWorkerdCondition: false },
};
