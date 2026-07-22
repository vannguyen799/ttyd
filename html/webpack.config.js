const path = require('path');
const { merge } = require('webpack-merge');
const ESLintPlugin = require('eslint-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const fs = require('fs');
const { spawn } = require('child_process');

const devMode = process.env.NODE_ENV !== 'production';

// Cap on an accepted paste. Screenshots are far below this; the limit exists
// because this handler sits on the single public port.
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

// Load an image into the X clipboard of the headless display started by
// ttyd/scripts/start-clipboard-x.sh, so Claude Code's Ctrl+V finds it:
//
//   xclip -selection clipboard -t TARGETS -o | grep image/png   → detect
//   xclip -selection clipboard -t image/png -o > tmpfile        → read
//
// Two subtleties drive the shape of this function:
//  1. X selections have no storage — the *owning process* serves each request
//     on demand. xclip therefore forks and must outlive this HTTP request, so
//     it is detached and unref'd. Ownership transfer reaps it when the next
//     image arrives.
//  2. Piping via stdin (rather than a temp file) means nothing touches disk,
//     so there is no leaked file to clean up if the process dies mid-paste.
function setClipboardImage(buf) {
    return new Promise((resolve, reject) => {
        const display = process.env.TTYD_CLIP_DISPLAY || ':77';
        const child = spawn('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i'], {
            env: { ...process.env, DISPLAY: display },
            detached: true,
            stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.on('error', err =>
            reject(new Error(err.code === 'ENOENT' ? 'xclip not installed' : err.message))
        );
        child.stdin.on('error', err => reject(new Error(`xclip stdin: ${err.message}`)));
        // xclip reads to EOF, claims the selection, then forks into the
        // background — so ending stdin is what actually arms the clipboard.
        child.stdin.end(buf, () => {
            child.unref();
            resolve();
        });
    });
}

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
        setupMiddlewares: (middlewares, devServer) => {
            // Image paste bridge. The browser can't reach the host clipboard,
            // so the UI POSTs the pasted image here and we load it into the
            // headless X clipboard; the client then sends Ctrl+V to the PTY
            // and Claude Code picks it up as a native [Image #N].
            devServer.app.post('/clipboard-image', (req, res) => {
                // Same gate as the terminal: ttyd's /token hands the browser
                // base64("user:pass") and the client replays it verbatim (see
                // refreshToken() in xterm/index.ts). No credential file means
                // ttyd runs --no-auth, so the open port is intentional.
                const cred = readTtydCredential();
                if (cred && req.headers.authorization !== `Basic ${cred}`) {
                    res.set('WWW-Authenticate', 'Basic realm="ttyd"');
                    res.status(401).json({ error: 'unauthorized' });
                    return;
                }

                const chunks = [];
                let size = 0;
                let aborted = false;
                req.on('data', chunk => {
                    if (aborted) return;
                    size += chunk.length;
                    if (size > MAX_IMAGE_BYTES) {
                        aborted = true;
                        res.status(413).json({ error: 'image too large' });
                        req.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                req.on('end', () => {
                    if (aborted) return;
                    if (size === 0) {
                        res.status(400).json({ error: 'empty body' });
                        return;
                    }
                    setClipboardImage(Buffer.concat(chunks))
                        .then(() => res.json({ ok: true }))
                        .catch(err => {
                            console.error('[ttyd] clipboard-image failed:', err.message);
                            res.status(500).json({ error: err.message });
                        });
                });
            });
            return middlewares;
        },
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
