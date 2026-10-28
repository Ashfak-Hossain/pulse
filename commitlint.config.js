// Conventional Commits: type(scope): summary, e.g. feat(money): add largest remainder split
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Only the types the team agreed in the README
    'type-enum': [2, 'always', ['feat', 'fix', 'test', 'refactor', 'docs', 'chore', 'build', 'ci']],
  },
};
