const gts = require('gts');

module.exports = [
    { ignores: ['dist/**'] },
    ...gts,
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            parserOptions: {
                jsxPragma: 'h',
            },
        },
        rules: {
            '@typescript-eslint/no-duplicate-enum-values': 'off',
        },
    },
    {
        files: ['gulpfile.js', 'webpack.config.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: {
                Buffer: 'readonly',
                __dirname: 'readonly',
                module: 'readonly',
                process: 'readonly',
                require: 'readonly',
            },
        },
        rules: {
            'n/no-unpublished-require': 'off',
        },
    },
];
