/**
 * =====================================================================
 * 首页 · 任务大厅（v6 · 「下单入口页」而不是「任务列表页」）
 * ---------------------------------------------------------------------
 * 改版依据：docs/ui-style-v1.png 第 08 节「首页改版方向」
 *   ① 顶部不再放「任务大厅」超大标题（导航栏已写「校园跑腿」，避免重复）；
 *   ② 搜索独占一行，右侧只留一个「筛选」入口，不再把 搜索/排序/筛选 挤三行；
 *   ③ 金刚区：取快递 / 食堂带饭 / 打印资料 / 超市代买 四个下单入口，
 *      点击直达发布页并自动预填模板；第五格「自定义发布」覆盖任意任务；
 *   ④ 未完成任务置顶为深色卡（用户最关心「手里还有没有没完事的单」），带实时倒计时；
 *   ⑤ 排序与筛选收进底部 Sheet，首屏高度全部让给任务列表。
 * 数据：GET /api/task/list（分页 / 排序 / 筛选）
 *       GET /api/task/myTake?status=0,1,2、GET /api/task/myPublish?status=0,1,2（置顶卡）
 * 未登录可浏览列表；发布 / 接单需要登录 + 校园认证通过。
 * =====================================================================
 */

const { get, showError } = require('../../utils/request');
const filter = require('../../utils/filter');
const theme = require('../../utils/theme');
const { MSG } = require('../../utils/constant');
const dialog = require('../../utils/dialog');

const app = getApp();

/**
 * 卡片堆叠（一摞牌）的交互参数
 * ---------------------------------------------------------------------
 * 交互形态是「滑动即切换」，不是「按住拖着走」：
 *   手指在牌堆上向上/向下轻轻一滑后松手，顶层卡片就自动沿手势方向飞到最后一层，
 *   身后的卡片同时弹簧式补位前移，全程由 WXSS 动画驱动，不需要一直按着屏幕。
 * SWIPE_MIN     ：竖向滑动超过该距离（px）即触发一次切换；
 * FLICK_MIN     ：快速轻扫时的最小位移（px），低于它一律当误触，不切换；
 * FLICK_VELOCITY：快速轻扫的速度阈值（px/ms），达标就不必滑满 SWIPE_MIN，手感更轻快；
 * FLY_DURATION  ：「抽出 → 插回堆底」动画时长（ms），必须与 wxss 里 .deck-card-fly-up / -down 的 animation-duration 一致；
 * FADE_DELAY    ：归位那张「瞬移」到堆底后，隔一帧再淡入的间隔（ms）；
 * START_SLOP    ：手指位移超过该值才判定手势主方向，避免「手指一抖卡片就跑」。
 */
const DECK = {
  SWIPE_MIN: 32,
  FLICK_MIN: 16,
  FLICK_VELOCITY: 0.5,
  FLY_DURATION: 440,
  FADE_DELAY: 40,
  START_SLOP: 6
};

/**
 * 顶部牌堆收录的任务状态口径
 * ---------------------------------------------------------------------
 * '0,1,2' = 待接单 + 进行中 + 待雇主确认，也就是「我手里还没完事的单」。
 * 已完成(3) / 超时取消(4) / 雇主撤销(5) 一律不进牌堆。
 * 后端 /api/task/myTake 与 /api/task/myPublish 支持逗号分隔的多状态筛选，故这里传字符串。
 */
const UNFINISHED_STATUS = '0,1,2';

/**
 * 金刚区快捷下单入口
 * key 与发布页（publishTask）的快捷模板一一对应，通过 ?tpl=key 传给发布页自动预填；
 * key='custom' 是「自定义发布」，直接进空白表单。
 */
const QUICK_ENTRIES = [
  { key: 'express', name: '取快递', img: '/images/tpl/express.png', meta: '限时60 · ¥0.8' },
  { key: 'meal', name: '食堂带饭', img: '/images/tpl/meal.png', meta: '限时40 · ¥1' },
  { key: 'print', name: '打印资料', img: '/images/tpl/print.png', meta: '限时60 · ¥3' },
  { key: 'market', name: '超市代买', img: '/images/tpl/market.png', meta: '限时60 · ¥3' }
];

Page({
  data: {
    list: [],
    page: 1,
    pageSize: 10,
    total: 0,
    hasMore: true,
    loading: false,
    // 主体 scroll-view 的下拉刷新是否处于「刷新中」；指示器收起完全由它驱动
    refreshing: false,
    keyword: '',
    sort: 'time_desc',
    minReward: '',
    maxReward: '',
    isLogin: false,
    canPublish: false,
    // ---------------- 主题（浅色 / 深色） ----------------
    // themeClass：页面根节点的主题类，模块加载时同步取一次，保证首帧就是正确主题、不闪白
    themeClass: theme.getClass(),
    // 开关是否处于「深色」态（开关的视觉状态）
    isDark: theme.isDark(),
    // 开关右侧文案：只显示当前实际主题（浅色 / 深色）；
    // 「跟随系统」是隐藏态，用户长按开关可回到它（见 onLongPressTheme）
    themeLabel: theme.isDark() ? MSG.THEME_LABEL_DARK : MSG.THEME_LABEL_LIGHT,
    // 下拉刷新指示器：背景与页面同色、转圈颜色与深浅色相反，否则深色下会出现一条白带
    refresherBg: theme.isDark() ? '#0f1116' : '#f5f7fa',
    refresherStyle: theme.isDark() ? 'white' : 'black',
    // 顶部一行身份提示：让用户一进首页就知道「我现在能不能发单 / 接单」
    heroTip: '',
    sortOptions: [
      { label: '最新发布', value: 'time_desc' },
      { label: '最早发布', value: 'time_asc' },
      { label: '酬金从高到低', value: 'reward_desc' },
      { label: '酬金从低到高', value: 'reward_asc' }
    ],
    // ---------------- 金刚区 ----------------
    quickEntries: QUICK_ENTRIES.map((item) => ({ ...item, badge: '' })),
    // ---------------- 未完成任务堆叠卡（所有没完事的单都在这里） ----------------
    // runningTasks：全部「未完成」的任务（待接单 0 / 进行中 1 / 待确认 2），按「先发布的在前」排序后堆叠展示
    //   key / pos / hidden：渲染用的牌位字段，由 decorateDeckPositions 统一算好
    //   remainSeconds：null 表示不限时（该条不参与倒计时）
    runningTasks: [],
    // 当前在最上层的是第几张卡片（从 0 开始），数组顺序 = 牌堆顺序
    deckIndex: 0,
    // 正在飞出的那张卡：flyId 是它的任务 id，flyDir 决定往上飞（up）还是往下飞（down）
    // 两者同时为空串 = 当前没有飞出动画
    flyId: '',
    flyDir: '',

    // ---------------- 排序与筛选 Sheet ----------------
    filterSheet: false,
    // 是否有生效中的筛选条件（有则在筛选入口上点一个小圆点提示）
    filterActive: false,
    // 确认按钮文案里的条数提示不需要，保持极简，只留一个「确定」
    serviceFee: ''
  },

  onShow() {
    // 主题先行：从别的页面 / 设置页回来时，深色偏好可能已经改了，这里重新校准
    this.syncTheme();
    const isLogin = app.isLogin();
    const canPublish = !!(app.globalData.userInfo && app.globalData.userInfo.isCampusAudit === 2);
    this.setData({
      heroTip: canPublish
        ? '认证已通过，随时可以发布任务或接单'
        : isLogin
          ? '完成校园认证后即可发布任务、接单赚酬金'
          : '登录后可发布任务、接单赚酬金'
    });
    this.refreshQuickBadge();
    // 每次进入页面刷新第一页，保证状态最新
    this.loadList(true);
    // 堆叠卡数据要先到位，倒计时才能按最新列表启动（不限时的卡片不参与倒计时）
    this.loadRunningTask().then(() => this.startRunningTimer());
    // 底部「我的任务」角标（未完成任务数）也一起校准
    app.refreshTakeBadge();
  },

  onHide() {
    this.stopRunningTimer();
  },

  onUnload() {
    this.stopRunningTimer();
    theme.unsync(this);
  },

  /**
   * 下拉刷新（主体滚动区 scroll-view 的 refresher）
   * ------------------------------------------------------------------
   * 为什么不用原生下拉刷新（index.json 里 enablePullDownRefresh 仍是 false）：
   *   首页顶部就是「进行中任务牌堆」。原生下拉刷新是页面级、原生层实现的，
   *   即使用 catchtouchmove 拦手势也拦不干净 —— 在牌堆上滑卡片会把整页拽下来刷新。
   * 现在的方案：
   *   首页外壳是「固定头部（品牌行 + 搜索行 + 牌堆）+ 主体 <scroll-view scroll-y refresher-enabled>」，
   *   牌堆被放在滚动区之外 —— 这是唯一确定性有效的隔离方式：
   *   scroll-view 的 refresher 属组件级原生手势，refresher-enabled 在手指按下那一刻就被锁定，
   *   catchtouchstart / catchtouchmove 都拦不住（已实测），动态开关也来不及。
   *   物理隔离之后：在牌堆上竖滑 = 切卡（永远是纯 JS 手势），在滚动区下拉 = 刷新，两者永不互抢。
   * 注意：refresher-triggered 必须由 JS 明确置回 false，指示器才会收起，
   *      所以收尾留了 260ms 停留，避免请求太快、指示器一闪而过像没生效。
   */
  async onRefresherRefresh() {
    if (this.data.refreshing) return;
    this.setData({ refreshing: true });
    try {
      await Promise.all([this.loadList(true), this.loadRunningTask()]);
      this.startRunningTimer();
    } catch (err) {
      // loadList / loadRunningTask 内部已各自兜底，这里只防御未知异常，防止指示器卡住不收起
    }
    setTimeout(() => this.setData({ refreshing: false }), 260);
  },

  /**
   * 兼容入口：如果以后把 index.json 的 enablePullDownRefresh 改回 true，
   * 原生下拉也会走同一套刷新逻辑（当前首页是 false，不会触发）。
   */
  onPullDownRefresh() {
    this.onRefresherRefresh().then(() => wx.stopPullDownRefresh());
  },

  /** 触底加载更多（页面级；主体改成 scroll-view 后由 onScrollToLower 接管） */
  onReachBottom() {
    this.loadMore();
  },

  /** 主体滚动区触底：与 onReachBottom 共用同一套分页逻辑，避免两处判断写歪 */
  onScrollToLower() {
    this.loadMore();
  },

  /** 加载下一页：还有数据、且当前没有请求在飞时才继续 */
  loadMore() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadList(false);
    }
  },

  /**
   * 加载任务列表
   * @param {boolean} reset 是否重置为第一页
   */
  async loadList(reset) {
    if (this.data.loading) return;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });

    try {
      const res = await get('/api/task/list', {
        page,
        pageSize: this.data.pageSize,
        keyword: this.data.keyword,
        sort: this.data.sort,
        minReward: this.data.minReward,
        maxReward: this.data.maxReward
      });
      const data = res.data;
      this.setData({
        list: reset ? data.list : this.data.list.concat(data.list),
        page: data.page,
        total: data.total,
        hasMore: data.hasMore
      });
    } catch (err) {
      // 未登录时浏览列表不做强制跳转，仅提示
      if (err.code !== 401) showError(err);
      this.setData({ list: reset ? [] : this.data.list, hasMore: false });
    } finally {
      this.setData({ loading: false });
    }
  },

  // ==================================================================
  // 金刚区：四个下单入口 + 自定义发布
  // ==================================================================

  /** 「取快递」入口右上角的免费代拿次数角标（有权益才显示） */
  refreshQuickBadge() {
    const user = app.globalData.userInfo || {};
    const count = Number(user.freeDeliveryCount) || 0;
    const available = user.freeDeliveryAvailable !== false && count > 0;
    this.setData({
      quickEntries: QUICK_ENTRIES.map((item) => ({
        ...item,
        badge: item.key === 'express' && available ? `免${count}` : ''
      }))
    });
  },

  /**
   * 点击金刚区入口：直达发布页并预填对应模板
   * 拦截逻辑与「自定义发布」完全一致（登录 + 校园认证）
   */
  goQuick(e) {
    const key = e.currentTarget.dataset.key;
    if (!this.ensureCanPublish()) return;
    const url = key === 'custom'
      ? '/pages/publishTask/publishTask'
      : `/pages/publishTask/publishTask?tpl=${key}`;
    wx.navigateTo({ url });
  },

  /** 自定义发布（金刚区第五格 / 兜底入口） */
  goPublish() {
    if (!this.ensureCanPublish()) return;
    wx.navigateTo({ url: '/pages/publishTask/publishTask' });
  },

  /**
   * 发布前置校验：必须登录且校园认证通过（后端仍有强制校验，这里只是提前提示）
   * @returns {boolean} 是否放行
   */
  ensureCanPublish() {
    if (!app.checkLogin()) return false;
    const user = app.globalData.userInfo;
    if (!user || user.isCampusAudit !== 2) {
      dialog.show(this, {
        title: '需要校园认证',
        content: '发布任务前请先完成校园认证，认证通过后可解锁全部发布与接单权限。',
        confirmText: '去认证'
      }).then((res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/campusCert/campusCert' });
      });
      return false;
    }
    return true;
  },

  // ==================================================================
  // 未完成任务堆叠卡（所有没完事的单都在这里，上下滑动切换）
  // ==================================================================

  /**
   * 拉取「未完成」的任务，用于顶部堆叠展示
   * ------------------------------------------------------------------
   * 数据来源：我发的单（myPublish）+ 我接的单（myTake），两份合并后一起展示；
   * 状态口径：UNFINISHED_STATUS（0,1,2）—— 待接单 + 进行中 + 待雇主确认，
   *          与「我的任务」角标一样以「没完事」为准，避免用户找不到自己挂在手上的单；
   * 排序口径：publish_time 升序 —— 最早发布的排在最上层，之后发布的任务依次排在后面；
   *          时间相同时按任务 id 升序，保证顺序稳定、刷新后不会跳动。
   * 容错：接口失败只让堆叠卡消失，绝不影响下面的任务列表主流程。
   */
  async loadRunningTask() {
    if (!app.isLogin()) {
      this.resetDeck();
      return;
    }
    try {
      const [takeRes, pubRes] = await Promise.all([
        get('/api/task/myTake', { page: 1, pageSize: 20, status: UNFINISHED_STATUS }),
        get('/api/task/myPublish', { page: 1, pageSize: 20, status: UNFINISHED_STATUS })
      ]);
      const takedList = (takeRes.data.list || []).map((task) => ({ task, roleLabel: '我是跑腿员' }));
      const publishList = (pubRes.data.list || []).map((task) => ({ task, roleLabel: '我是雇主' }));
      const merged = takedList.concat(publishList).sort((a, b) => {
        // publish_time 是定长字符串 YYYY-MM-DD HH:mm:ss，字典序比较等价于时间比较，
        // 且不依赖 iOS 对 YYYY-MM-DD HH:mm:ss 的日期解析（iOS 不支持这种格式）
        const timeA = String(a.task.publishTime || '');
        const timeB = String(b.task.publishTime || '');
        if (timeA !== timeB) return timeA < timeB ? -1 : 1;
        return Number(a.task.id) - Number(b.task.id);
      });
      const tasks = merged.map((entry) => this.buildRunningCard(entry));
      // 刷新后尽量停在用户正在看的那张牌上：先按 id 找它的新下标，找不到才回到第一张
      const prevTopId = (this.data.runningTasks[this.data.deckIndex] || {}).id;
      let deckIndex = 0;
      if (prevTopId !== undefined && prevTopId !== null) {
        const found = tasks.findIndex((item) => String(item.id) === String(prevTopId));
        if (found > -1) deckIndex = found;
      }
      // 数组顺序 = 牌堆顺序（第 0 条是最早发布的），再给每张算好牌位 pos
      this.setData({
        runningTasks: this.decorateDeckPositions(tasks, deckIndex),
        deckIndex,
        flyId: '',
        flyDir: ''
      });
    } catch (err) {
      this.resetDeck();
    }
  },

  /** 清空牌堆（未登录 / 接口失败时调用），同时把飞出动画的状态一起复位 */
  resetDeck() {
    if (!this.data.runningTasks.length && !this.data.flyId) return;
    this.setData({ runningTasks: [], deckIndex: 0, flyId: '', flyDir: '' });
  },

  /**
   * 把接口返回的任务对象转成堆叠卡需要的展示字段
   * @param {object} entry { task, roleLabel }
   */
  buildRunningCard(entry) {
    const task = entry.task;
    const remainSeconds = typeof task.remainSeconds === 'number' ? task.remainSeconds : null;
    const overtime = remainSeconds !== null && remainSeconds <= 0;
    // 进度条第几段（后端 computeProgressStep 的唯一出口，0 表示还没人接单）
    const progressStep = Number(task.progressStep) || 0;
    // 限时倒计时条状态：配色 / 文案与详情页共用 filter.limitBarState，两处永远一致
    const bar = filter.limitBarState(task);
    return {
      id: task.id,
      orderNo: task.orderNo || '',
      roleLabel: entry.roleLabel,
      // 任务类型标签（取快递 / 食堂带饭 / 打印资料 / 超市代买 / 其他）
      taskTypeText: task.taskTypeText || filter.taskTypeText(task.taskType),
      statusText: filter.taskStatusText(task.status),
      // 状态标签配色：与列表标签 / 卡片左侧色条同源，在 filter 里唯一映射
      statusClass: filter.taskDeckStatusClass(task.status),
      deliverAddress: task.deliverAddress || '',
      rewardText: filter.price(task.reward),
      // 进行中(1) 且限时 → 显示 mm:ss 倒计时；待接单(0)/待确认(2) 或不限时 → 显示时长口径
      isCountdown: remainSeconds !== null,
      remainSeconds,
      remainText: remainSeconds !== null
        ? (overtime ? '已超时' : filter.countdownText(remainSeconds))
        : filter.timeLimitText(task.timeLimitMin),
      overtime,
      // ---------------- 限时倒计时条 ----------------
      barClass: bar.className,
      barPercent: bar.percent,
      barText: bar.text,
      // ---------------- 5 段进度 ----------------
      progressStep,
      progressText: filter.progressText(progressStep),
      steps: filter.progressSteps(progressStep),
      // 进度连线长度：第 1 段在 10% 处、第 5 段在 90% 处，每走过一段点亮 20%
      flowPercent: Math.max(0, Math.min(4, progressStep - 1)) * 20,
      // 接单人头像：第 2 段起卡片左侧会展示（含「已接单」小标）
      takerAvatar: task.takerAvatar ? filter.imageUrl(task.takerAvatar) : ''
    };
  },

  /**
   * 计算每张卡在牌堆里的牌位
   * ------------------------------------------------------------------
   * 用「相对位置」而不是数组下标：切换时每张卡只换 class，节点不重建，动画才连得上；
   * pos = 0 顶层（当前这张）／1、2 依次向上向右错位；3 表示收在堆底不显示，随切换依次浮上来。
   * key：wx:key 用的稳定标识，保证切换时节点被复用而不是重建；
   * hidden：刚归位到堆底的那张先隐藏，下一帧再淡入，避免它从飞出方向「弹」回来。
   * @param {Array} tasks 卡片数据（数组顺序 = 牌堆顺序）
   * @param {number} deckIndex 当前在最上层的是第几张
   * @param {string} hiddenId 需要先隐藏的那张卡的任务 id（可省略）
   */
  decorateDeckPositions(tasks, deckIndex, hiddenId) {
    const len = tasks.length;
    if (!len) return [];
    const start = ((deckIndex % len) + len) % len;
    return tasks.map((task, index) => {
      const pos = (index - start + len) % len;
      return Object.assign({}, task, {
        key: 'c' + task.id,
        pos: pos > 2 ? 3 : pos,
        hidden: !!hiddenId && String(task.id) === String(hiddenId)
      });
    });
  },

  /**
   * 启动堆叠卡倒计时（本地每秒递减，不请求接口）
   * 不限时（remainSeconds === null）的卡片不参与倒计时；全部归零后自动停表。
   */
  startRunningTimer() {
    this.stopRunningTimer();
    const list = this.data.runningTasks || [];
    const hasCountdown = list.some((task) => typeof task.remainSeconds === 'number' && task.remainSeconds > 0);
    if (!hasCountdown) return;
    this._runningTimer = setInterval(() => {
      const current = this.data.runningTasks || [];
      if (!current.length) {
        this.stopRunningTimer();
        return;
      }
      // 只更新发生变化的字段路径，避免每秒把整个数组推给渲染层造成卡顿
      const patch = {};
      let changed = false;
      current.forEach((task, index) => {
        if (typeof task.remainSeconds !== 'number' || task.remainSeconds <= 0) return;
        const next = task.remainSeconds - 1;
        changed = true;
        patch['runningTasks[' + index + '].remainSeconds'] = next;
        patch['runningTasks[' + index + '].remainText'] = next > 0 ? filter.countdownText(next) : '已超时';
        patch['runningTasks[' + index + '].overtime'] = next <= 0;
        // 倒计时条同步递减：归零那一帧立刻切成亮红「已超时」，颜色档位与详情页一致
        const bar = filter.limitBarState({
          status: task.status,
          remainSeconds: next,
          timeLimitMin: task.timeLimitMin,
          isOvertime: next <= 0,
          overtimeSeconds: task.overtimeSeconds
        });
        patch['runningTasks[' + index + '].barClass'] = bar.className;
        patch['runningTasks[' + index + '].barPercent'] = bar.percent;
        patch['runningTasks[' + index + '].barText'] = bar.text;
      });
      if (!changed) {
        this.stopRunningTimer();
        return;
      }
      this.setData(patch);
    }, 1000);
  },

  /** 停止堆叠卡倒计时（页面隐藏 / 卸载时必须停，避免后台空转耗电） */
  stopRunningTimer() {
    if (this._runningTimer) {
      clearInterval(this._runningTimer);
      this._runningTimer = null;
    }
  },

  // ---------------------- 牌堆：滑动即切换（上滑看下一张 / 下滑看上一张） ----------------------

  /**
   * 手指按下：只记起点，不做任何跟手位移
   * 说明：卡片是「滑动即自动切换」，不是「按住拖着走」，所以按下这一刻画面完全不动。
   */
  onDeckTouchStart(e) {
    if (this._flying) return;
    const touch = (e.touches && e.touches[0]) || null;
    if (!touch) return;
    this._deckStartX = touch.clientX;
    this._deckStartY = touch.clientY;
    this._deckStartAt = Date.now();
    this._deckAxis = '';
  },

  /**
   * 手指移动：只判定手势主方向，不移动卡片
   * 竖向手势会被 WXML 上的 catchtouchmove 拦下 —— 页面不会跟着滚，也不会触发下拉刷新。
   */
  onDeckTouchMove(e) {
    const touch = (e.touches && e.touches[0]) || null;
    if (!touch || typeof this._deckStartY !== 'number') return;
    const deltaX = touch.clientX - this._deckStartX;
    const deltaY = touch.clientY - this._deckStartY;
    // 第一次拿到有效位移时定下手势方向，之后不再反复横跳
    if (!this._deckAxis) {
      if (Math.abs(deltaX) < DECK.START_SLOP && Math.abs(deltaY) < DECK.START_SLOP) return;
      this._deckAxis = Math.abs(deltaY) >= Math.abs(deltaX) ? 'y' : 'x';
    }
  },

  /**
   * 手指抬起：竖向滑动达到「位移」或「速度」阈值 → 自动切换一次
   * 松手之后卡片自己飞走、后面的自己补位，不需要用户继续按着屏幕。
   */
  onDeckTouchEnd(e) {
    const axis = this._deckAxis;
    const startY = this._deckStartY;
    const startAt = this._deckStartAt || 0;
    this._deckAxis = '';
    this._deckStartY = null;
    this._deckStartAt = 0;
    if (axis !== 'y' || typeof startY !== 'number') return;
    const touch = (e.changedTouches && e.changedTouches[0]) || null;
    if (!touch) return;
    const deltaY = touch.clientY - startY;
    const distance = Math.abs(deltaY);
    const cost = Math.max(1, Date.now() - startAt);
    // 快速轻扫：位移不用很大，只要够快也算一次有效滑动，手感更轻快
    const flick = distance >= DECK.FLICK_MIN && distance / cost >= DECK.FLICK_VELOCITY;
    if (distance < DECK.SWIPE_MIN && !flick) return;
    this.switchDeck(deltaY < 0 ? 'up' : 'down');
  },

  /** 手势被系统打断（来电、返回手势等）：什么都不用做，卡片本来就没被拖动过 */
  onDeckTouchCancel() {
    this._deckAxis = '';
    this._deckStartY = null;
    this._deckStartAt = 0;
  },

  /**
   * 切换牌堆（核心）
   * ------------------------------------------------------------------
   * 一次切换只做两帧，动画全部交给 WXSS，所以既跟手又顺滑：
   *   第 1 帧：立刻换牌 —— deckIndex 指向下一张，身后的卡片同时弹簧式补位前移；
   *           被换下去的那张在数据上已经排到队尾，视觉上先被「钉」在顶层姿势，
   *           再按手势方向被「抽」出牌堆：先向上（下滑则向下）抬起一小段，
   *           随后斜着插回牌堆最后一层的空位并淡出，像扑克牌从第一张抽出来插到最后一张后面。
   *           这里用 @keyframes 而不是 transition，新加的 class 会在同一帧直接开播；
   *   第 2 帧：飞完后它已落到堆底，先透明一帧（hidden，同时关掉过渡，
   *           否则它会从飞出方向倒着滑回来），紧接着摘掉 hidden 让它淡入。
   * 上滑 = 看下一张，下滑 = 看上一张，两者互为反向，来回滑可以原路切回。
   * @param {string} dir  up 上滑 ／ down 下滑
   */
  switchDeck(dir) {
    const list = this.data.runningTasks || [];
    const len = list.length;
    // 只有一张牌时没有下一张可看，直接忽略
    if (len < 2) return;
    const fromIndex = this.data.deckIndex || 0;
    const flownId = list[fromIndex].id;
    const nextIndex = dir === 'down' ? (fromIndex - 1 + len) % len : (fromIndex + 1) % len;
    // 动画期间再滑不响应，避免连续猛滑把牌序打乱
    this._flying = true;
    this.setData({
      deckIndex: nextIndex,
      flyId: flownId,
      flyDir: dir,
      runningTasks: this.decorateDeckPositions(list, nextIndex, '')
    });
    setTimeout(() => {
      // 归位那一帧：它在数据上已经排到最后，用 hidden 先藏住并关掉过渡
      this.setData({
        flyId: '',
        flyDir: '',
        runningTasks: this.decorateDeckPositions(list, nextIndex, flownId)
      });
      setTimeout(() => {
        // 下一帧摘掉 hidden → 在堆底自然淡入，整摞牌恢复完整
        this.setData({ runningTasks: this.decorateDeckPositions(list, nextIndex, '') });
        this._flying = false;
      }, DECK.FADE_DELAY);
    }, DECK.FLY_DURATION);
  },

  /** 点击卡片进入对应任务详情（只有最上层那张响应；切换动画期间的点击会被屏蔽） */
  goRunning(e) {
    if (this._flying) return;
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {};
    if (Number(dataset.pos) !== 0 || !dataset.id) return;
    wx.navigateTo({ url: '/pages/taskDetail/taskDetail?id=' + dataset.id });
  },

  // ==================================================================
  // 主题（浅色 / 深色）
  // ==================================================================

  /**
   * 把主题模块解析出的唯一真值同步到页面
   * 只做两件事：① 页面根节点的主题类；② 开关的状态与文案。
   * 颜色本身不在这里 —— 全部由 app.wxss 的 CSS 变量按类名切换。
   * @returns {boolean} 当前是否深色
   */
  syncTheme() {
    const isDark = theme.sync(this);
    // 小字只表达「现在是什么主题」，不再显示「跟随系统」：
    // 跟随系统时按系统实际深浅显示 浅色 / 深色，用户看到的就是真实观感
    const themeLabel = isDark ? MSG.THEME_LABEL_DARK : MSG.THEME_LABEL_LIGHT;
    const refresherBg = isDark ? '#0f1116' : '#f5f7fa';
    const refresherStyle = isDark ? 'white' : 'black';
    if (this.data.isDark !== isDark || this.data.themeLabel !== themeLabel
      || this.data.refresherBg !== refresherBg || this.data.refresherStyle !== refresherStyle) {
      this.setData({ isDark, themeLabel, refresherBg, refresherStyle });
    }
    return isDark;
  },

  /**
   * 点开关：在浅色 / 深色之间切换（手动锁定，优先级高于系统设置）
   * 首次手动切换时会顺带提示「长按可恢复跟随系统」——
   * 否则这个能力没有任何入口，用户永远不知道它存在。
   */
  onToggleTheme() {
    const from = theme.getMode();
    const { mode, dark } = theme.toggle();
    this.syncTheme();
    // 从「跟随系统」切到手动锁定：顺带把「长按可恢复跟随系统」告诉用户（不然后面想切回去找不到入口）
    const firstLock = from === theme.MODES.AUTO;
    wx.showToast({
      title: firstLock ? (dark ? MSG.THEME_TOAST_DARK : MSG.THEME_TOAST_LIGHT) + MSG.THEME_TOAST_HINT
        : (dark ? MSG.THEME_TOAST_DARK : MSG.THEME_TOAST_LIGHT),
      icon: 'none',
      duration: firstLock ? 2400 : 1500
    });
    console.log('[theme] toggle', from, '->', mode);
  },

  /** 长按开关：清掉手动偏好，恢复跟随系统深浅色 */
  onResetTheme() {
    if (theme.isAuto()) {
      wx.showToast({ title: MSG.THEME_TOAST_AUTO, icon: 'none' });
      return;
    }
    theme.setMode(theme.MODES.AUTO);
    this.syncTheme();
    wx.showToast({ title: MSG.THEME_TOAST_AUTO, icon: 'none' });
  },

  // ==================================================================
  // 搜索
  // ==================================================================

  /** 搜索关键词输入 */
  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  /** 点击搜索 */
  onSearch() {
    this.syncFilterActive();
    this.loadList(true);
  },

  /** 清空搜索关键词，并立刻按空关键词重新拉取列表 */
  clearKeyword() {
    if (!this.data.keyword) return;
    this.setData({ keyword: '' });
    this.syncFilterActive();
    this.loadList(true);
  },

  // ==================================================================
  // 排序与筛选（收进底部 Sheet，首屏只留一个入口）
  // ==================================================================

  /** 打开筛选面板 */
  openFilter() {
    this.setData({ filterSheet: true });
  },

  /** 关闭筛选面板 */
  closeFilter() {
    this.setData({ filterSheet: false });
  },

  /** 切换排序（Sheet 内即时生效，不必等「确定」） */
  onSortChange(e) {
    const sort = e.currentTarget.dataset.value;
    this.setData({ sort });
    this.syncFilterActive();
    this.loadList(true);
  },

  /** 酬金区间输入 */
  onRewardInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  /** 应用筛选：关闭面板并按新条件重新拉取 */
  applyFilter() {
    this.setData({ filterSheet: false });
    this.syncFilterActive();
    this.loadList(true);
  },

  /** 重置筛选（保留关键词，避免用户以为搜索被吞了） */
  resetFilter() {
    this.setData({ minReward: '', maxReward: '', sort: 'time_desc' });
    this.syncFilterActive();
    this.loadList(true);
  },

  /** 计算「筛选入口」上是否要显示生效中的小圆点 */
  syncFilterActive() {
    const active = !!this.data.keyword
      || !!this.data.minReward
      || !!this.data.maxReward
      || this.data.sort !== 'time_desc';
    if (active !== this.data.filterActive) this.setData({ filterActive: active });
  }
});