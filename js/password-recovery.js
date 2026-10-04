/*
  BA Science — Password Recovery
  Uses Supabase Auth. Never stores or logs passwords/tokens.
*/

(() => {
    "use strict";

    const client = window.baSupabase;
    const form = document.getElementById("forgotPasswordForm");
    const message = document.getElementById("recoveryMessage");
    const languageButton = document.getElementById("languageButton");

    let language =
        localStorage.getItem("ba-language") === "en" ? "en" : "ar";

    function t(ar, en) {
        return language === "ar" ? ar : en;
    }

    function applyLanguage() {
        document.documentElement.lang = language;
        document.documentElement.dir =
            language === "ar" ? "rtl" : "ltr";

        document.querySelectorAll("[data-ar][data-en]")
            .forEach((element) => {
                element.textContent =
                    language === "ar"
                        ? element.dataset.ar
                        : element.dataset.en;
            });

        if (languageButton) {
            languageButton.textContent =
                language === "ar" ? "EN" : "AR";
        }

        document.title = t(
            "BA Science | استعادة كلمة المرور",
            "BA Science | Password Recovery"
        );
    }

    function showMessage(text, success = false) {
        if (!message) return;

        message.textContent = text;
        message.style.color =
            success ? "#27875a" : "#c24b59";
    }

    languageButton?.addEventListener("click", () => {
        language = language === "ar" ? "en" : "ar";
        localStorage.setItem("ba-language", language);
        applyLanguage();
    });

    applyLanguage();

    if (!form) return;

    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const email =
            document.getElementById("recoveryEmail")
                ?.value.trim() ?? "";

        if (!email) return;

        if (!client) {
            showMessage(t(
                "تعذّر تهيئة خدمة تسجيل الدخول.",
                "Authentication service is unavailable."
            ));
            return;
        }

        if (!["http:", "https:"].includes(location.protocol)) {
            showMessage(t(
                "افتح الموقع باستخدام خادم محلي، وليس file://.",
                "Open the site using a local server, not file://."
            ));
            return;
        }

        const submitButton =
            form.querySelector('button[type="submit"]');

        if (submitButton) submitButton.disabled = true;

        showMessage(t(
            "جارٍ إرسال الطلب...",
            "Processing your request..."
        ));

        try {
            const redirectTo = new URL(
                "./reset-password.html",
                window.location.href
            ).href;

            const { error } =
                await client.auth.resetPasswordForEmail(email, {
                    redirectTo
                });


if (error) {
    if (
        error.status === 429 ||
        error.code === "over_email_send_rate_limit"
    ) {
        showMessage(t(
            "تم بلوغ الحد المؤقت لإرسال رسائل البريد. يرجى الانتظار قبل إعادة المحاولة.",
            "The temporary email sending limit has been reached. Please wait before trying again."
        ));
        return;
    }

    // Keep other errors generic to protect account privacy.
    showMessage(t(
        "تعذّر إكمال الطلب حالياً. حاول لاحقاً.",
        "Unable to process the request. Try again later."
    ));
    return;
}


            showMessage(t(
                "إذا كان البريد مؤهلاً للاستعادة، فستصلك رسالة تحتوي على رابط إعادة تعيين كلمة المرور.",
                "If this email is eligible for recovery, you will receive a password reset link."
            ), true);

        } catch {
            showMessage(t(
                "حدث خطأ في الاتصال. حاول لاحقاً.",
                "Connection error. Please try again later."
            ));

        } finally {
            if (submitButton) submitButton.disabled = false;
        }
    });
})();

/* ================================================
   BA Science — Reset Password
================================================ */

(() => {
    "use strict";

    const form = document.getElementById("resetPasswordForm");

    if (!form) return;

    const client = window.baSupabase;
    const message = document.getElementById("resetMessage");
    const newPassword = document.getElementById("newPassword");
    const confirmPassword =
        document.getElementById("confirmNewPassword");
    const submitButton =
        document.getElementById("resetPasswordButton");

    let recoveryVerified = false;
    let completed = false;
    let processing = false;

    function translate(ar, en) {
        return document.documentElement.lang === "en" ? en : ar;
    }

    function showMessage(ar, en, success = false) {
        if (!message) return;

        // Keep both languages available for the language switcher.
        message.dataset.ar = ar;
        message.dataset.en = en;

        message.textContent = translate(ar, en);
        message.style.color = success ? "#27875a" : "#c24b59";
    }

    function enableFields(enabled) {
        newPassword.disabled = !enabled;
        confirmPassword.disabled = !enabled;
        submitButton.disabled = !enabled;
    }

    enableFields(false);

    if (!client) {
        showMessage(
            "تعذّر تهيئة خدمة المصادقة.",
            "Authentication service is unavailable."
        );
        return;
    }

    const params = new URLSearchParams(
        window.location.hash.replace(/^#/, "")
    );

    const queryParams = new URLSearchParams(
        window.location.search
    );

    const recoveryLinkHasError =
        params.has("error") ||
        params.has("error_code") ||
        queryParams.has("error") ||
        queryParams.has("error_code");

    if (recoveryLinkHasError) {
        showMessage(
            "رابط الاستعادة غير صالح أو انتهت صلاحيته. اطلب رابطاً جديداً.",
            "The recovery link is invalid or expired. Request a new one."
        );
    }

    // An ordinary authenticated session must NOT unlock this form.
    // Only Supabase's password-recovery event can unlock it.
    client.auth.onAuthStateChange((event, session) => {
        if (completed) return;

        if (event === "INITIAL_SESSION" && !recoveryVerified) {
            enableFields(false);

            const hashError = new URLSearchParams(
                window.location.hash.slice(1)
            ).get("error_code");

            const queryError = new URLSearchParams(
                window.location.search
            ).get("error_code");

            if (hashError === "otp_expired" || queryError === "otp_expired") {
                showMessage(
                    "انتهت صلاحية رابط الاستعادة أو تم استخدامه مسبقاً. يرجى طلب رابط جديد.",
                    "The recovery link has expired or was already used. Please request a new one."
                );
            } else {
                showMessage(
                    "افتح رابط الاستعادة المرسل إلى بريدك الإلكتروني، أو اطلب رابطاً جديداً.",
                    "Open the recovery link sent to your email, or request a new one."
                );
            }

            return;
        }

        if (
            event === "PASSWORD_RECOVERY" &&
            session &&
            !recoveryLinkHasError
        ) {
            recoveryVerified = true;

            enableFields(true);

            showMessage(
                "تم التحقق من رابط الاستعادة. يمكنك تعيين كلمة مرور جديدة.",
                "Recovery link verified. You can set a new password.",
                true
            );
        }
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (!recoveryVerified || completed || processing) {
            showMessage(
                "يجب فتح رابط استعادة صالح أولاً.",
                "A valid recovery link is required."
            );
            return;
        }

        const password = newPassword.value;
        const confirmation = confirmPassword.value;

        if (password.length < 12 || password.length > 128) {
            showMessage(
                "يجب أن تتكون كلمة المرور من 12 إلى 128 حرفاً.",
                "Password must contain 12 to 128 characters."
            );
            return;
        }

        if (password !== confirmation) {
            showMessage(
                "كلمتا المرور غير متطابقتين.",
                "Passwords do not match."
            );
            return;
        }

        processing = true;
        enableFields(false);

        showMessage(
            "جارٍ تحديث كلمة المرور...",
            "Updating your password..."
        );

        try {
            const { error } = await client.auth.updateUser({
                password
            });

            if (error) {
                // Diagnostic metadata only.
                // Never log passwords, sessions or authentication tokens.
                console.warn("BA Password Recovery:", {
                    status: error.status ?? null,
                    code: error.code ?? "unknown"
                });

                if (error.code === "same_password") {
                    showMessage(
                        "كلمة المرور الجديدة يجب أن تختلف عن كلمة المرور السابقة.",
                        "Your new password must differ from the previous password."
                    );
                } else {
                    showMessage(
                        "تعذّر تحديث كلمة المرور. يرجى مراجعة متطلبات كلمة المرور أو صلاحية رابط الاستعادة.",
                        "Unable to update the password. Check the password requirements or recovery link validity."
                    );
                }

                enableFields(true);
                return;
            }

            completed = true;
            recoveryVerified = false;

            newPassword.value = "";
            confirmPassword.value = "";

            showMessage(
                "تم تحديث كلمة المرور بنجاح. يمكنك العودة إلى تسجيل الدخول.",
                "Password updated successfully. You can return to sign in.",
                true
            );

            // End the temporary recovery session locally.
            try {
                await client.auth.signOut({ scope: "local" });
            } catch {
                // Password update already succeeded.
            }

        } catch {
            showMessage(
                "حدث خطأ في الاتصال. حاول مجدداً.",
                "Connection error. Please try again."
            );

            enableFields(true);

        } finally {
            processing = false;
        }
    });
})();
