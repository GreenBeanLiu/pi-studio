module.exports = {
  root: true,
  extends: ['@electron-toolkit/eslint-config-ts/recommended'],
  ignorePatterns: ['dist', 'out', 'node_modules'],
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'off',
  },
}
