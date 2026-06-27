const path = require('path');
const { merge } = require('webpack-merge');
const ESLintPlugin = require('eslint-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const fs = require('fs');

const devMode = process.env.NODE_ENV !== 'production';

// ttyd Basic Auth credential, base64("user:pass") — the same value ttyd's
// /token endpoint returns and what its check_auth() compares against. Read
// lazily (per WS upgrade) so a rotated password is picked up without
// restarting webpack. Source: TTYD_CREDENTIAL env, else the file written by
// start-ttyd.sh.
function readTtydCredential() {
    if (process.env.TTYD_CREDENTIAL) return process.env.TTYD_CREDENTIAL.trim();
    try {
        return fs.readFileSync(process.env.TTYD_CRED_FILE || '/tmp/ttyd.cred', 'utf8').trim();
    } catch {
        return '';
    }
}

const baseConfig = {
    context: path.resolve(__dirname, 'src'),
    entry: {
        app: './index.tsx',
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        // Content-hash the bundle in BOTH dev and prod. Mobile browsers
        // (iOS Safari / Android Chrome) cache `app.js` aggressively and a
        // plain refresh keeps serving the stale file because the URL never
        // changes — even with Cache-Control: no-store. Hashing the filename
        // forces a fresh fetch on every rebuild: the no-store HTML always
        // points at the new `app.<hash>.js`, which the browser has never seen.
        filename: '[name].[contenthash].js',
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.s?[ac]ss$/,
                use: [devMode ? 'style-loader' : MiniCssExtractPlugin.loader, 'css-loader', 'sass-loader'],
            },
        ],
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    plugins: [
        new ESLintPlugin({
            context: path.resolve(__dirname, '.'),
            extensions: ['js', 'jsx', 'ts', 'tsx'],
        }),
        new CopyWebpackPlugin({
            patterns: [{ from: './favicon.png', to: '.' }],
        }),
        new MiniCssExtractPlugin({
            filename: devMode ? '[name].css' : '[name].[contenthash].css',
            chunkFilename: devMode ? '[id].css' : '[id].[contenthash].css',
        }),
        new HtmlWebpackPlugin({
            inject: false,
            minify: {
                removeComments: true,
                collapseWhitespace: true,
            },
            title: 'ttyd - Terminal',
            template: './template.html',
        }),
    ],
    performance: {
        hints: false,
    },
};

const devConfig = {
    mode: 'development',
    devServer: {
        static: path.join(__dirname, 'dist'),
        compress: true,
        port: 9000,
        headers: {
            'Cache-Control': 'no-store',
        },
        client: {
            overlay: {
                errors: true,
                warnings: false,
            },
        },
        proxy: [
            {
                context: ['/token', '/ws'],
                target: 'http://localhost:7681',
                ws: true,
                // Safari/iOS (WebKit) does not send the Authorization header on
                // the WebSocket upgrade, so ttyd's check_auth() rejects the
                // handshake (ECONNRESET) even after the user passed Basic Auth.
                // We control the webpack→ttyd hop, so inject the Basic
                // credential here. onProxyReqWs only fires for the /ws upgrade —
                // /token stays untouched, so its 401 still gates access via the
                // browser login dialog. Security is unchanged: the WS still
                // requires a valid AuthToken message, obtainable only from the
                // Basic-Auth-protected /token.
                onProxyReqWs: proxyReq => {
                    const cred = readTtydCredential();
                    if (cred) proxyReq.setHeader('Authorization', `Basic ${cred}`);
                },
            },
        ],
        webSocketServer: {
            type: 'sockjs',
            options: {
                path: '/sockjs-node',
            },
        },
    },
    devtool: 'inline-source-map',
};

const prodConfig = {
    mode: 'production',
    optimization: {
        minimizer: [new TerserPlugin(), new CssMinimizerPlugin()],
    },
    devtool: 'source-map',
};

module.exports = merge(baseConfig, devMode ? devConfig : prodConfig);
