// v1.31.1 (security review 2026-10-03, item 12): the content security policy is on. It was
// off, while the console kept a credential in localStorage — so any injected script could
// read it and send it anywhere. The console is one same-origin bundle (src/public/dashboard,
// built by Vite with no inline script) plus the setup wizard, whose script moved out of the
// page for this. Scripts and connections are same-origin only.
//
// `style-src 'unsafe-inline'` is a deliberate allowance: the wizard and the console set
// inline styles, and a style cannot read storage or make a request the policy allows.
// `upgrade-insecure-requests` is dropped because a local `http://localhost` install would
// have every request rewritten to an https that is not there.
export const CONTENT_SECURITY_POLICY = {
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    scriptSrcAttr: ["'none'"],
  },
};
