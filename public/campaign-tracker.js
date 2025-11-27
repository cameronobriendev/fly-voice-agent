// Universal campaign tracking for static HTML pages
(function() {
    // Helper to get cookie
    function getCookie(name) {
        const value = '; ' + document.cookie;
        const parts = value.split('; ' + name + '=');
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    // Helper to set cookie
    function setCookie(name, value, days) {
        const expires = new Date();
        expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
        document.cookie = name + '=' + value + ';expires=' + expires.toUTCString() + ';path=/;domain=.cameronobrien.dev;secure;samesite=lax';
    }

    // Check URL for ?client parameter
    const urlParams = new URLSearchParams(window.location.search);
    const clientParam = urlParams.get('client');

    if (clientParam) {
        // Create session ID
        const sessionId = clientParam + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

        // Set cookies (30 days)
        setCookie('__campaign_client', clientParam, 30);
        setCookie('__campaign_session', sessionId, 30);

        console.log('Campaign click tracked:', { client: clientParam, session: sessionId });
    }

    // Track pageview if campaign cookies exist
    function trackPageview() {
        const campaignClient = getCookie('__campaign_client');
        const campaignSession = getCookie('__campaign_session');

        if (campaignClient && campaignSession) {
            // Send to tracking API
            fetch('https://www.cameronobrien.dev/api/campaigns/track', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    client: campaignClient,
                    session: campaignSession,
                    page: window.location.pathname,
                    timestamp: new Date().toISOString()
                })
            }).then(function() {
                console.log('Campaign pageview tracked');
            }).catch(function(err) {
                console.error('Campaign tracking error:', err);
            });

            // Also send Umami event if available
            if (window.umami) {
                window.umami.track('campaign-pageview', {
                    client: campaignClient,
                    session: campaignSession,
                    page: window.location.pathname
                });
            }
        }
    }

    // Track on page load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', trackPageview);
    } else {
        trackPageview();
    }
})();
