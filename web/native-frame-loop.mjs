export function createNativeFrameLoop({
  draw,isVisible=()=>true,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,
  activeInterval=33,idleInterval=250,activityWindow=600,onError=()=>{},
}) {
  let running=false,inflight=false,timer;
  let lastStarted=-Infinity,lastActivity=-Infinity,retryAt=-Infinity;

  function clearScheduled() {
    if (!timer) return;
    clearTimer(timer.id);
    timer=undefined;
  }
  function nextStart(time) {
    const interval=time-lastActivity<activityWindow ? activeInterval : idleInterval;
    return Math.max(time,lastStarted+interval,retryAt);
  }
  function schedule() {
    if (!running || inflight) return;
    if (!isVisible()) {clearScheduled();return;}
    const time=now(),at=nextStart(time);
    if (timer?.at===at) return;
    clearScheduled();
    const scheduled={at};
    timer=scheduled;
    scheduled.id=setTimer(()=>{
      if (timer!==scheduled) return;
      timer=undefined;
      void tick();
    },at-time);
  }
  async function tick() {
    if (!running || inflight || !isVisible()) return;
    const time=now();
    // Activity can expire while a timer waits. Recheck the cadence rather than
    // drawing an extra active-rate frame after the loop has become idle.
    if (nextStart(time)>time) {schedule();return;}
    inflight=true;
    lastStarted=time;
    try {
      await draw();
      retryAt=-Infinity;
    } catch (error) {
      retryAt=now()+idleInterval;
      // Reporting errors must not turn a handled draw failure into an unhandled
      // rejection, including when an optional reporter is asynchronous.
      try {Promise.resolve(onError(error)).catch(()=>{});} catch {}
    } finally {
      inflight=false;
      if (running) schedule();
    }
  }
  function start() {
    if (running) return;
    running=true;
    schedule();
  }
  function stop() {running=false;clearScheduled();}
  function request() {
    lastActivity=now();
    schedule();
  }
  return {start,stop,request};
}
