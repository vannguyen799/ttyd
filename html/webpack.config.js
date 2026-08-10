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

// The ttyd instance this dev server proxies to. In production ttyd serves the
// bundle itself, so this only matters while iterating on html/ — point it at
// whatever port start-ttyd.sh is using.
const TTYD_ORIGIN = `http://localhost:${process.env.TTYD_PORT || 10090}`;

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
        // Everything that isn't the bundle goes to the real ttyd, including
        // /image-upload — the image-paste bridge lives in the binary
        // (src/image_upload.c), so dev mode exercises the same code production
        // does instead of a second, drifting implementation.
        proxy: [
            {
                context: ['/token', '/ws', '/image-upload', '/tabs'],
                target: TTYD_ORIGIN,
                ws: true,
                // Safari/iOS (WebKit) does not send the Authorization header on
                // a WebSocket upgrade. ttyd no longer requires it there (the
                // AuthToken message is the gate), but injecting it keeps this
                // proxy working against an older ttyd too.
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
