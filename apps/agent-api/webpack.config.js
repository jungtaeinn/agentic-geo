const path = require('path');
const nodeExternals = require('webpack-node-externals');

module.exports = (options) => ({
  ...options,
  plugins: (options.plugins ?? []).filter(
    (plugin) => plugin?.constructor?.name !== 'ForkTsCheckerWebpackPlugin',
  ),
  externals: [
    nodeExternals({
      modulesDir: path.resolve(__dirname, '../../node_modules'),
      allowlist: [/^@agentic-geo\//],
    }),
    nodeExternals({
      modulesDir: path.resolve(__dirname, 'node_modules'),
      allowlist: [/^@agentic-geo\//],
    }),
  ],
  module: {
    ...options.module,
    rules: [
      {
        test: /\.ts$/,
        loader: 'ts-loader',
        options: {
          transpileOnly: true,
          configFile: path.resolve(__dirname, 'tsconfig.build.json'),
        },
        include: [
          path.resolve(__dirname, 'src'),
          path.resolve(__dirname, '../../packages'),
        ],
      },
    ],
  },
  resolve: {
    ...options.resolve,
    extensions: ['.ts', '.js'],
  },
});
