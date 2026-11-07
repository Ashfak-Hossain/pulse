// Who may import whom. The reasons are in docs/code-structure.md; run with `pnpm check:arch`.
// Folders that are not features. Any other folder under src/ counts as one, so a new feature is
// covered without touching this file
const WORKER_BASE = 'kafka|rabbit|shared|config';
const API_BASE = 'common|config|db';
const workerFeature = `^apps/worker/src/(?!(?:${WORKER_BASE})/)([^/]+)/`;
const apiFeature = `^apps/api/src/(?!(?:${API_BASE})/)([^/]+)/`;

const PURE = '^packages/(matching|money|geo)/src/';
const TEST_FILE = '\\.spec\\.ts$';

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'A cycle means neither file can be read or tested without the other.',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'packages-never-import-apps',
      comment: 'Packages are the lower layer; apps build on them.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-never-import-apps',
      comment: 'The web app, API and worker run apart. Shared code goes in a package.',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'nothing-imports-an-entry-file',
      comment: 'main.ts runs the program when loaded, so importing it would start everything.',
      severity: 'error',
      from: {},
      to: { path: '^apps/[^/]+/src/main\\.ts$' },
    },
    {
      name: 'pure-packages-stay-pure',
      comment: 'CLAUDE.md rule 5: matching, money and geo touch no database, network or Node API.',
      severity: 'error',
      from: { path: PURE, pathNot: TEST_FILE },
      to: {
        path: [
          '^packages/(db|events|jobs|contracts|catalog-adapters|request-parser)/',
          // An import that does not resolve yet keeps its written name
          '^@pulse/(db|events|jobs|contracts|catalog-adapters|request-parser)',
          '(^|node_modules/)(pg|drizzle-orm|amqplib|@platformatic/kafka)(/|$)',
        ],
      },
    },
    {
      name: 'pure-packages-use-no-node-api',
      comment: 'CLAUDE.md rule 5: fs, net, crypto and the like are the shell, not the core.',
      severity: 'error',
      from: { path: PURE, pathNot: TEST_FILE },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'worker-features-stay-apart',
      comment: 'main.ts connects the features. Code two of them need moves to shared/.',
      severity: 'error',
      from: { path: workerFeature },
      to: { path: workerFeature, pathNot: '^apps/worker/src/$1/' },
    },
    {
      name: 'worker-base-never-imports-features',
      comment: 'kafka, rabbit, shared and config must stay usable by any feature.',
      severity: 'error',
      from: { path: `^apps/worker/src/(?:${WORKER_BASE})/` },
      to: { path: workerFeature },
    },
    {
      name: 'worker-shared-is-a-leaf',
      comment: 'shared/ knows no broker; a helper that needs Kafka belongs in kafka/.',
      severity: 'error',
      from: { path: '^apps/worker/src/shared/' },
      to: { path: '^apps/worker/src/(?:kafka|rabbit|config)/' },
    },
    {
      name: 'api-base-never-imports-features',
      comment: 'common, config and db must stay usable by any module.',
      severity: 'error',
      from: { path: `^apps/api/src/(?:${API_BASE})/` },
      to: { path: apiFeature },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|coverage|\\.next|\\.turbo)/' },
    // Counts `import type` too: a wrong direction is wrong even when only a type crosses it
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default', 'node'],
      extensions: ['.ts', '.js', '.json'],
    },
  },
};
