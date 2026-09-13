// Stand-in for the optional `superagent-proxy` plugin. rest-facade does
// `require("superagent-proxy")(superagent)` only when a proxy is configured;
// this deployment never configures one. Returning the client unchanged keeps
// both call shapes (`plugin(superagent)` and `import plugin from …`) valid.
function superagentProxyStub(superagent) {
  return superagent;
}
module.exports = superagentProxyStub;
module.exports.default = superagentProxyStub;
