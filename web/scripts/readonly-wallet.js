// Test harness only, never bundled into the app. An EIP-6963 wallet that reports the account owner's public address and
// forwards reads to the public RPC. It signs nothing: every signing or sending request is rejected like a user
// declining it. make-probe-app.mjs injects it into a copy of the built index.html so the connected UI can be read.
(() => {
  const OWNER = '0x2aD12a72362704367e99a344cFf5affDDF7f5DEF';
  const RPC = 'https://rpc.testnet.chain.robinhood.com';
  const go = new URLSearchParams(location.search).get('go');
  if (go) history.replaceState(null, '', go);
  const refuse = new Set(['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'eth_signTransaction']);
  const provider = {
    isRabby: true,
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [OWNER];
      if (method === 'eth_chainId') return '0xb626';
      if (method === 'net_version') return '46630';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
      if (refuse.has(method)) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    },
    on() {},
    removeListener() {},
  };
  const info = { uuid: '00000000-0000-4000-8000-000000000001', name: 'Read-only owner', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'io.rabby' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();
