const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const source = fs.readFileSync(
    "js/password-recovery.js",
    "utf8"
);

function createTestPage(hash = "") {
    const elements = {};

    function element(id) {
        return elements[id] ??= {
            disabled: false,
            value: "",
            textContent: "",
            dataset: {},
            style: {},
            addEventListener(name, callback) {
                this.listeners ??= {};
                this.listeners[name] = callback;
            }
        };
    }

    const form = element("resetPasswordForm");
    const password = element("newPassword");
    const confirm = element("confirmNewPassword");
    const button = element("resetPasswordButton");
    const message = element("resetMessage");

    let authCallback;

    const client = {
        auth: {
            onAuthStateChange(callback) {
                authCallback = callback;
                return {
                    data: {
                        subscription: {
                            unsubscribe() {}
                        }
                    }
                };
            }
        }
    };

    const window = {
        baSupabase: client,
        location: {
            hash,
            search: ""
        }
    };

    const document = {
        documentElement: {
            lang: "ar",
            dir: "rtl"
        },
        getElementById(id) {
            if (id === "forgotPasswordForm") return null;
            if (id === "languageButton") return null;
            return elements[id] ?? null;
        },
        querySelectorAll() {
            return [];
        },
        title: ""
    };

    vm.runInNewContext(source, {
        window,
        document,
        URLSearchParams,
        URL,
        localStorage: {
            getItem() { return null; },
            setItem() {}
        }
    });

    assert.equal(
        typeof authCallback,
        "function",
        "Auth listener was not registered"
    );

    return {
        password,
        confirm,
        button,
        message,
        emit(event, session = null) {
            authCallback(event, session);
        },
        allLocked() {
            return (
                password.disabled &&
                confirm.disabled &&
                button.disabled
            );
        },
        allEnabled() {
            return (
                !password.disabled &&
                !confirm.disabled &&
                !button.disabled
            );
        }
    };
}

// 1. Direct access without a recovery link.
{
    const page = createTestPage();

    page.emit("INITIAL_SESSION", null);

    assert.ok(page.allLocked());

    console.log("PASS: Direct access remains locked");
}

// 2. An ordinary signed-in user cannot unlock recovery.
{
    const page = createTestPage();

    page.emit("INITIAL_SESSION", null);
    page.emit("SIGNED_IN", { user: { id: "test-user" } });

    assert.ok(page.allLocked());

    console.log("PASS: Ordinary session remains locked");
}

// 3. A valid recovery event unlocks the form.
{
    const page = createTestPage();

    page.emit("INITIAL_SESSION", null);
    page.emit("PASSWORD_RECOVERY", {
        user: { id: "test-user" }
    });

    assert.ok(page.allEnabled());

    console.log("PASS: Recovery event unlocks the form");
}

// 4. An invalid recovery URL must never unlock the form.
{
    const page = createTestPage(
        "#error=access_denied&error_code=otp_expired"
    );

    page.emit("INITIAL_SESSION", null);
    page.emit("PASSWORD_RECOVERY", {
        user: { id: "test-user" }
    });

    assert.ok(page.allLocked());

    console.log("PASS: Expired recovery URL remains locked");
}

console.log("OVERALL: PASS (4 recovery scenarios)");
