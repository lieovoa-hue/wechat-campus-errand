/**
 * =====================================================================
 * 公告组件（两种形态，同一个组件按 mode 区分）
 * ---------------------------------------------------------------------
 *   mode="bar"     全局通知条：各页面顶部一条可关闭的横幅（同一时刻显示一条，
 *                  关掉后自动顶上未关闭的下一条；多条时右侧显示 1/2 计数）
 *   mode="marquee" 首页跑马灯：横向滚动播报，多条按顺序轮播，点一下看下一条
 * 数据来源：utils/announce.js（60 秒模块缓存 + 并发去重，失败静默降级）
 * =====================================================================
 */

const announce = require('../../utils/announce');
const { MSG } = require('../../utils/constant');

Component({
  properties: {
    /** bar = 顶部通知条 / marquee = 首页跑马灯 */
    mode: { type: String, value: 'bar' }
  },

  data: {
    // ---------------- 通知条 ----------------
    barVisible: false,
    barContent: '',
    barClosable: true,
    barIndex: 0,
    barTotal: 0,
    // ---------------- 跑马灯 ----------------
    marqueeItems: [],
    marqueeContent: '',
    marqueeShow: false,
    marqueeDuration: 12,
    label: MSG.ANNOUNCE_MARQUEE_LABEL
  },

  lifetimes: {
    attached() {
      this.load();
    },
    detached() {
      this.clearMarqueeTimer();
    }
  },

  methods: {
    /** 拉取公告并渲染（按 mode 走不同分支） */
    async load() {
      const data = await announce.fetchActive();
      if (this.data.mode === 'marquee') {
        this.applyMarquee(data.marquee || []);
      } else {
        this.applyBar(data.notice || []);
      }
    },

    // ==================== 通知条 ====================

    /** this._noticeList 保存「尚未被用户关闭」的通知条，关闭一条后自动顶上一条 */
    applyBar(list) {
      this._noticeList = list.filter((item) => !announce.isNoticeClosed(item.id));
      // 总数只算一次：关掉一条后序号继续往后走（1/3 → 2/3），而不是重新变成 1/2
      this._noticeTotal = this._noticeList.length;
      this.showCurrentNotice();
    },

    showCurrentNotice() {
      const list = this._noticeList || [];
      if (!list.length) {
        this.setData({ barVisible: false });
        return;
      }
      const item = list[0];
      const total = this._noticeTotal || list.length;
      this.setData({
        barVisible: true,
        barContent: item.content,
        barClosable: item.closable !== false,
        barIndex: total - list.length + 1,
        barTotal: total
      });
    },

    /** 关闭当前通知条：记入本次会话的关闭名单，并顶上未关闭的下一条 */
    closeNotice() {
      const list = this._noticeList || [];
      if (list.length) {
        announce.closeNotice(list[0].id);
        list.shift();
      }
      this.showCurrentNotice();
    },

    // ==================== 跑马灯 ====================

    applyMarquee(list) {
      this.clearMarqueeTimer();
      if (!list.length) {
        this.setData({ marqueeItems: [], marqueeShow: false });
        return;
      }
      this.setData({ marqueeItems: list, marqueeContent: list[0].content });
      this.restartMarquee();
    },

    /**
     * 重新开始滚动
     * 关键点：先卸载节点再重新挂载（marqueeShow 先 false 再 true），
     * 否则 CSS 动画不会重播，第二条公告就会停在那儿不动。
     */
    restartMarquee() {
      const item = (this.data.marqueeItems || [])[0] || {};
      const text = String(item.content || '');
      const duration = Math.max(8, Math.min(30, 7 + text.length * 0.45));
      this.clearMarqueeTimer();
      this.setData({ marqueeShow: false, marqueeContent: text, marqueeDuration: duration });
      this._marqueeRenderTimer = setTimeout(() => {
        this.setData({ marqueeShow: true });
      }, 30);
      // 滚完之后切下一条（动画是线性的，duration 秒后正好走完）
      this._marqueeTimer = setTimeout(() => this.nextMarquee(), duration * 1000 + 300);
    },

    /** 切到下一条公告（点跑马灯也能切） */
    nextMarquee() {
      const list = this.data.marqueeItems || [];
      if (list.length <= 1) {
        this.restartMarquee();
        return;
      }
      const rotated = list.slice(1).concat(list.slice(0, 1));
      this.setData({ marqueeItems: rotated });
      this.restartMarquee();
    },

    clearMarqueeTimer() {
      if (this._marqueeTimer) {
        clearTimeout(this._marqueeTimer);
        this._marqueeTimer = null;
      }
      if (this._marqueeRenderTimer) {
        clearTimeout(this._marqueeRenderTimer);
        this._marqueeRenderTimer = null;
      }
    }
  }
});
