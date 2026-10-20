# MuleWatch analyst app

Next.js front end and API routes for MuleWatch. See the
[repository README](../README.md) for architecture, environment variables and
setup.

```
src/
  app/
    (workspace)/      alerts, network, evaluate – require a session
    api/              route handlers; the only code with the service-role key
    login/            sign-in
    fonts/            vendored IBM Plex subsets (SIL OFL)
  components/
    alerts/           queue, filters (URL state), review drawer
    network/          graph model (pure, tested) and explorer
    evaluate/         scoring form and result
    ui.tsx            shared primitives and design tokens in use
  lib/
    server/auth.ts    token verification and analyst allowlist
    api-client.ts     authenticated fetch with timeouts and typed errors
```

Design tokens live in `src/app/globals.css` (`@theme`).
