/**
 * V2-M0：pipe.yml 脚手架模板库。
 *
 * 每种模板都产出一个能直接通过 parsePipe 的最小可运行流水线（build → release 两段）。
 * 模板只给起点，用户随后在编辑器里改。所有模板共用同一套外壳，差别只在 runtime/app/build/artifacts。
 *
 * 解析器只认内联数组（`hosts: [a, b]`、`artifacts: ["x"]`），所以这里统一用内联写法。
 */

export const SCAFFOLD_KINDS = [
  { id: 'static', name: '静态站点 / 产物包', runtime: 'static', description: '打包成 tgz 上传，不重启服务' },
  { id: 'node', name: 'Node.js', runtime: 'node', description: 'npm 构建 + pm2 重启' },
  { id: 'python', name: 'Python', runtime: 'python', description: 'pip 安装 + systemd --user 重启' },
  { id: 'go', name: 'Go', runtime: 'static', description: 'go build 出二进制' },
  { id: 'bare', name: '空白模板', runtime: 'static', description: '只有一段 echo，改造成自己的流程' },
]

const BUILDS = {
  static: () => ({ command: 'tar -czf dist.tgz .', artifacts: ['dist.tgz'] }),
  node: () => ({ command: 'npm ci && npm run build', artifacts: ['dist/**'] }),
  python: () => ({ command: 'pip install -r requirements.txt', artifacts: ['app/**'] }),
  go: (app) => ({ command: `go build -o bin/${app} .`, artifacts: ['bin/**'] }),
  bare: () => ({ command: "echo 'hello from dsh-cicd'", artifacts: ['dist.tgz'] }),
}

function flow(items) {
  return `[${items.map((item) => `"${String(item).replaceAll('"', '\\"')}"`).join(', ')}]`
}

export function scaffoldPipe({
  name = 'demo',
  kind = 'static',
  hosts = ['host1'],
  path = `/srv/${name}`,
} = {}) {
  const template = SCAFFOLD_KINDS.find((item) => item.id === kind) || SCAFFOLD_KINDS[0]
  const runtime = template.runtime
  const app = kind === 'node' || kind === 'python' || kind === 'go' ? name : ''
  const build = (BUILDS[kind] || BUILDS.static)(app)
  const hostList = Array.isArray(hosts) && hosts.length ? hosts : ['host1']

  const lines = [
    'version: 1',
    `name: ${name}`,
    'targets:',
    '  prod:',
    `    hosts: ${flow(hostList)}`,
    `    path: ${path}`,
    `    runtime: ${runtime}`,
    ...(app ? [`    app: ${app}`] : []),
    '    keep: 5',
    'stages:',
    '  - id: build',
    '    steps:',
    '      - name: build',
    `        run: ${build.command}`,
    '  - id: release',
    '    needs: [build]',
    '    steps:',
    '      - name: ship',
    '        deploy:',
    '          target: prod',
    `          artifacts: ${flow(build.artifacts)}`,
  ]
  return `${lines.join('\n')}\n`
}
