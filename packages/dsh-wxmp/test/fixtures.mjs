/**
 * 单测 fixture：模拟微信接口的三类返回。
 * - appmsgpublish 双层 JSON 字符串（publish_page、publish_info 均为字符串）
 * - 文章页 HTML（含 js_content）
 * - searchbiz 响应
 */

/** 双层 JSON 的 appmsgpublish 列表响应（两篇文章）。 */
export const APPMSGPUBLISH_JSON = JSON.stringify({
  base_resp: { ret: 0, err_msg: 'ok' },
  publish_page: JSON.stringify({
    is_continue: 1,
    publish_list: [
      {
        publish_info: JSON.stringify({
          appmsgex: [
            {
              aid: '2247485712_1',
              title: '第一篇文章',
              link: 'https://mp.weixin.qq.com/s/AAA111',
              digest: '摘要一',
              cover: 'https://mmbiz.qpic.cn/cover1.jpg',
              author: '作者甲',
              update_time: 1750000000,
              create_time: 1750000000,
            },
            {
              aid: '2247485712_2',
              title: '第二篇文章',
              link: 'https://mp.weixin.qq.com/s/BBB222',
              digest: '摘要二',
              cover: '',
              author: '作者乙',
              update_time: 1749000000,
              create_time: 1749000000,
            },
          ],
        }),
      },
    ],
  }),
})

/** searchbiz 响应（两个公众号）。 */
export const SEARCHBIZ_JSON = JSON.stringify({
  base_resp: { ret: 0, err_msg: 'ok' },
  total: 2,
  list: [
    {
      fakeid: 'M1234567890',
      nickname: '测试号',
      alias: 'test-account',
      round_head_img: 'https://mmbiz.qpic.cn/avatar1.jpg',
      service_type: 1,
    },
    {
      fakeid: 'M0987654321',
      nickname: '另一个号',
      alias: '',
      round_head_img: 'https://mmbiz.qpic.cn/avatar2.jpg',
      service_type: 0,
    },
  ],
})

/** 登录过期（ret=-1）。 */
export const EXPIRED_JSON = JSON.stringify({ base_resp: { ret: -1, err_msg: 'session expired' } })

/** fakeid 无效（ret=200002）。 */
export const INVALID_FAKEID_JSON = JSON.stringify({ base_resp: { ret: 200002, err_msg: 'invalid arg' } })

/** 文章页 HTML：h1 标题 + js_name 作者 + publish_time + js_content 正文（图片用 data-src）。 */
export const ARTICLE_HTML = [
  '<!DOCTYPE html><html><head>',
  '<meta property="og:title" content="og标题"/>',
  '</head><body>',
  '<h1 class="rich_media_title" id="activity-name"> 测试文章标题 </h1>',
  '<span id="js_name"> 测试作者 </span>',
  '<script>var publish_time = "1750000000";var nickname = "脚本作者";</script>',
  '<div id="js_content">',
  '<p>第一段文字，含 <strong>加粗</strong> 与 <em>斜体</em>。</p>',
  '<h2>小节标题</h2>',
  '<img src="placeholder.png" data-src="https://mmbiz.qpic.cn/img1.jpg" alt="图一">',
  '<a href="https://example.com">外部链接</a>',
  '<ul><li>列表项甲</li><li>列表项乙</li></ul>',
  '<blockquote>引用一句话</blockquote>',
  '<pre><code>console.log("hi");</code></pre>',
  '<p>&amp; 符号转义 &lt;测试&gt;</p>',
  '</div>',
  '</body></html>',
].join('')

/** 缺少正文容器的残缺页面（应返回 null）。 */
export const BROKEN_HTML = '<html><body><h1>404</h1></body></html>'
