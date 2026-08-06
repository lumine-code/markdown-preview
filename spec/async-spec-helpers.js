async function conditionPromise(condition, description = "anonymous condition", timeout = 5000) {
  const startTime = Date.now();

  while (true) {
    await timeoutPromise(100);

    if (await condition()) {
      return;
    }

    if (Date.now() - startTime > timeout) {
      throw new Error("Timed out waiting on " + description);
    }
  }
}

function timeoutPromise(timeout) {
  return new Promise(function (resolve) {
    global.setTimeout(resolve, timeout);
  });
}

module.exports = { conditionPromise, timeoutPromise };
