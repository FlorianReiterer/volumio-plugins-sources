'use strict';

/**
 * Mother Earth Radio Plugin v1.4
 * 
 * Features:
 * - SSE (Server-Sent Events) for real-time metadata updates
 * - No polling, no ping - server pushes when track changes
 * - Proper async/await patterns
 * - Retry logic with exponential backoff
 * - Bookworm compatible
 */

const libQ = require('kew');
const fs = require('fs-extra');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// SSE reconnect settings
const SSE_RECONNECT_DELAY_MS = 3000;
const SSE_MAX_RECONNECT_ATTEMPTS = 10;

// High Latency Mode settings
const HIGH_LATENCY_BUFFER_KB = 32768;   // 32 MB buffer (~48 seconds @ 192k FLAC)
const HIGH_LATENCY_DELAY_MS = 2000;     // 2 second metadata delay
const NORMAL_BUFFER_KB = 4096;          // 4 MB buffer (Volumio default)

class MotherEarthRadio {
    constructor(context) {
        this.context = context;
        this.commandRouter = context.coreCommand;
        this.logger = context.logger;
        this.configManager = context.configManager;
        
        // Instance state
        this.state = {};
        this.currentUri = null;
        this.currentChannel = null;
        
        // SSE connection
        this.sseRequest = null;
        this.sseReconnectAttempts = 0;
        this.sseReconnectTimer = null;
        
        // Metadata delay (user-configurable for fine-tuning)
        this.metadataDelay = 0;
        
        // API host
        this.apiHost = 'motherearth.streamserver24.com';
        
        // Channels configuration
        this.channels = {
            'radio': {
                name: 'Radio',
                shortcode: 'motherearth',
                streams: {
                    flac192: 'https://motherearth.streamserver24.com/listen/motherearth/motherearth',
                    flac96: 'https://motherearth.streamserver24.com/listen/motherearth/motherearth.flac-lo',
                    aac: 'https://motherearth.streamserver24.com/listen/motherearth/motherearth.aac'
                }
            },
            'klassik': {
                name: 'Klassik',
                shortcode: 'motherearth_klassik',
                streams: {
                    flac192: 'https://motherearth.streamserver24.com/listen/motherearth_klassik/motherearth.klassik',
                    flac96: 'https://motherearth.streamserver24.com/listen/motherearth_klassik/motherearth.klassik.flac-lo',
                    aac: 'https://motherearth.streamserver24.com/listen/motherearth_klassik/motherearth.klassik.aac'
                }
            },
            'instrumental': {
                name: 'Instrumental',
                shortcode: 'motherearth_instrumental',
                streams: {
                    flac192: 'https://motherearth.streamserver24.com/listen/motherearth_instrumental/motherearth.instrumental',
                    flac96: 'https://motherearth.streamserver24.com/listen/motherearth_instrumental/motherearth.instrumental.flac-lo',
                    aac: 'https://motherearth.streamserver24.com/listen/motherearth_instrumental/motherearth.instrumental.aac'
                }
            },
            'jazz': {
                name: 'Jazz',
                shortcode: 'motherearth_jazz',
                streams: {
                    flac192: 'https://motherearth.streamserver24.com/listen/motherearth_jazz/motherearth.jazz',
                    flac96: 'https://motherearth.streamserver24.com/listen/motherearth_jazz/motherearth.jazz.flac-lo',
                    aac: 'https://motherearth.streamserver24.com/listen/motherearth_jazz/motherearth.jazz.aac'
                }
            }
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VOLUMIO LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════════

    onVolumioStart() {
        const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
        this.config = new (require('v-conf'))();
        this.config.loadFile(configFile);
        return libQ.resolve();
    }

    onStart() {
        this.mpdPlugin = this.commandRouter.pluginManager.getPlugin('music_service', 'mpd');
        
        this.loadI18nStrings();
        this.addToBrowseSources();
        
        // Load user-configured delay
        this.metadataDelay = this.config.get('apiDelay') || 3;
        
        // Load High Latency Mode setting
        this.highLatencyMode = this.config.get('highLatencyMode') || false;
        
        // Apply buffer settings if High Latency Mode is enabled
        if (this.highLatencyMode) {
            this.applyHighLatencyBuffer();
        }
        
        this.log('info', `Plugin started (SSE mode, High Latency: ${this.highLatencyMode})`);
        return libQ.resolve();
    }

    onStop() {
        this.stopSSE();
        this.removeFromBrowseSources();
        this.log('info', 'Plugin stopped');
        return libQ.resolve();
    }

    onRestart() {
        // Optional, use if you need it
        return libQ.resolve();
    }

    getConfigurationFiles() {
        return ['config.json'];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SSE (SERVER-SENT EVENTS) - Real-time metadata from AzuraCast
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Start SSE connection to AzuraCast for real-time metadata
     * The server pushes updates when tracks change - no polling needed!
     */
    startSSE(channelKey) {
        // Stop any existing connection
        this.stopSSE();
        
        const channel = this.channels[channelKey];
        if (!channel) {
            this.log('error', `Unknown channel: ${channelKey}`);
            return;
        }
        
        // Build SSE URL with subscription
        // AzuraCast SSE format: /api/live/nowplaying/sse?cf_connect={"subs":{"station:shortcode":{}}}
        const subs = {
            subs: {
                [`station:${channel.shortcode}`]: {}
            }
        };
        
        const sseUrl = `https://${this.apiHost}/api/live/nowplaying/sse?cf_connect=${encodeURIComponent(JSON.stringify(subs))}`;
        
        this.log('info', `🔌 Starting SSE connection for ${channel.name}`);
        this.log('debug', `SSE URL: ${sseUrl}`);
        
        this.connectSSE(sseUrl, channelKey);
    }

    /**
     * Connect to SSE endpoint
     */
    connectSSE(sseUrl, channelKey) {
        const url = new URL(sseUrl);
        
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            }
        };

        this.sseRequest = https.request(options, (response) => {
            if (response.statusCode !== 200) {
                this.log('error', `SSE connection failed: ${response.statusCode}`);
                this.scheduleSSEReconnect(sseUrl, channelKey);
                return;
            }

            this.log('info', '✅ SSE connected - waiting for track updates');
            this.sseReconnectAttempts = 0;  // Reset on successful connect

            let buffer = '';

            response.on('data', (chunk) => {
                buffer += chunk.toString();
                
                // SSE messages are separated by double newlines
                const messages = buffer.split('\n\n');
                buffer = messages.pop();  // Keep incomplete message in buffer
                
                for (const message of messages) {
                    this.handleSSEMessage(message, channelKey);
                }
            });

            response.on('end', () => {
                this.log('warn', 'SSE connection closed by server');
                this.scheduleSSEReconnect(sseUrl, channelKey);
            });

            response.on('error', (err) => {
                this.log('error', `SSE error: ${err.message}`);
                this.scheduleSSEReconnect(sseUrl, channelKey);
            });
        });

        this.sseRequest.on('error', (err) => {
            this.log('error', `SSE request error: ${err.message}`);
            this.scheduleSSEReconnect(sseUrl, channelKey);
        });

        this.sseRequest.end();
    }

    /**
     * Parse and handle SSE message
     */
    handleSSEMessage(message, channelKey) {
        // SSE format:
        // data: {"channel":"station:motherearth","pub":{"data":{"np":{...}}}}
        
        const lines = message.split('\n');
        let data = null;
        
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    data = JSON.parse(line.substring(6));
                } catch (e) {
                    // Ignore parse errors (ping messages are often empty)
                }
            }
        }
        
        if (!data) return;
        
        // Handle initial connect message
        if (data.connect) {
            this.log('debug', 'SSE connect message received');
            // Initial data might be in connect.data array
            if (data.connect.data && Array.isArray(data.connect.data)) {
                for (const item of data.connect.data) {
                    this.processNowPlayingData(item, channelKey);
                }
            }
            return;
        }
        
        // Handle regular update
        this.processNowPlayingData(data, channelKey);
    }

    /**
     * Process now playing data from SSE
     */
    processNowPlayingData(data, channelKey) {
        // Extract the actual now playing data
        const np = data?.pub?.data?.np || data?.np;
        
        if (!np || !np.now_playing) {
            return;  // Not a now playing update
        }

        const song = np.now_playing.song;
        const duration = np.now_playing.duration || 0;
        const elapsed = np.now_playing.elapsed || 0;
        
        if (!song) return;

        this.log('info', `🎵 Track update: ${song.artist} - ${song.title}`);
        
        // Get effective delay (manual + high latency mode)
        const delay = this.getEffectiveDelay();
        
        if (delay > 0) {
            this.log('debug', `Applying ${delay}ms metadata delay`);
            setTimeout(() => {
                this.updateMetadata(song, duration, elapsed, np);
            }, delay);
        } else {
            this.updateMetadata(song, duration, elapsed, np);
        }
    }

    /**
     * Update Volumio with new metadata
     */
    updateMetadata(song, duration, elapsed, np) {
        const channel = this.channels[this.currentChannel];
        if (!channel) return;

        this.state = {
            status: 'play',
            service: 'motherearthradio',
            title: song.title || 'Unknown',
            artist: song.artist || channel.name,
            album: song.album || '',
            albumart: song.art || '/albumart?sourceicon=music_service/motherearthradio/mer-logo-cube-bold-1x 512.png',
            uri: this.currentUri,
            trackType: this.currentUri?.includes('.aac') ? 'aac' : 'flac',
            seek: elapsed * 1000,
            duration: duration,
            samplerate: this.currentUri?.includes('.aac') ? '44.1 kHz' : '96 kHz',
            bitdepth: this.currentUri?.includes('.aac') ? '16 bit' : '24 bit',
            channels: 2,
            streaming: true,
            isStreaming: true,
            random: false,
            repeat: false,
            repeatSingle: false
        };

        this.commandRouter.servicePushState(this.state, 'motherearthradio');
    }

    /**
     * Schedule SSE reconnection with backoff
     */
    scheduleSSEReconnect(sseUrl, channelKey) {
        if (this.sseReconnectAttempts >= SSE_MAX_RECONNECT_ATTEMPTS) {
            this.log('error', `SSE: Max reconnect attempts (${SSE_MAX_RECONNECT_ATTEMPTS}) reached`);
            this.showToast('error', 'PLUGIN_NAME', 'ERROR_STREAM_SERVER');
            return;
        }

        this.sseReconnectAttempts++;
        const delay = SSE_RECONNECT_DELAY_MS * this.sseReconnectAttempts;
        
        this.log('info', `SSE: Reconnecting in ${delay}ms (attempt ${this.sseReconnectAttempts})`);
        
        this.sseReconnectTimer = setTimeout(() => {
            this.connectSSE(sseUrl, channelKey);
        }, delay);
    }

    /**
     * Stop SSE connection
     */
    stopSSE() {
        if (this.sseReconnectTimer) {
            clearTimeout(this.sseReconnectTimer);
            this.sseReconnectTimer = null;
        }
        
        if (this.sseRequest) {
            this.sseRequest.destroy();
            this.sseRequest = null;
        }
        
        this.sseReconnectAttempts = 0;
        this.log('debug', 'SSE connection stopped');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PLAYBACK CONTROL
    // ═══════════════════════════════════════════════════════════════════════════

    clearAddPlayTrack(track) {
        const defer = libQ.defer();
        
        // Determine channel and quality from URI
        this.currentChannel = this.getChannelFromUri(track.uri);
        this.currentQuality = this.getQualityFromUri(track.uri);
        this.currentUri = track.uri;
        
        // Get the actual stream URL
        const streamUrl = this.getStreamUrl(this.currentChannel, this.currentQuality);
        
        if (!streamUrl) {
            this.log('error', `Unknown channel/quality: ${track.uri}`);
            defer.reject('Unknown channel');
            return defer.promise;
        }
        
        this.log('info', `▶️ Playing: ${this.currentChannel}/${this.currentQuality} → ${streamUrl}`);
        
        // Start SSE for real-time metadata
        this.startSSE(this.currentChannel);
        
        // Tell MPD to play the stream
        this.commandRouter.pushConsoleMessage('[MER] Adding track to MPD: ' + streamUrl);
        
        this.mpdPlugin.sendMpdCommand('stop', [])
            .then(() => this.mpdPlugin.sendMpdCommand('clear', []))
            .then(() => this.mpdPlugin.sendMpdCommand('add "' + streamUrl + '"', []))
            .then(() => this.mpdPlugin.sendMpdCommand('play', []))
            .then(() => {
                // Set initial state while waiting for SSE data
                const channel = this.channels[this.currentChannel];
                const qualityLabel = this.getQualityLabel(this.currentQuality);
                this.state = {
                    status: 'play',
                    service: 'motherearthradio',
                    title: `${channel?.name || 'Mother Earth Radio'}`,
                    artist: 'Connecting...',
                    album: qualityLabel,
                    albumart: '/albumart?sourceicon=music_service/motherearthradio/mer-logo-cube-bold-1x 512.png',
                    uri: track.uri,
                    streaming: true,
                    isStreaming: true,
                    samplerate: this.getSampleRate(this.currentQuality),
                    bitdepth: this.getBitDepth(this.currentQuality)
                };
                this.commandRouter.servicePushState(this.state, 'motherearthradio');
                defer.resolve();
            })
            .fail((err) => {
                this.log('error', 'Failed to play track: ' + err);
                defer.reject(err);
            });
        
        return defer.promise;
    }

    getQualityLabel(quality) {
        const labels = {
            'flac192': 'FLAC 192kHz/24bit',
            'flac96': 'FLAC 96kHz/24bit',
            'aac': 'AAC 96kHz'
        };
        return labels[quality] || quality;
    }

    getSampleRate(quality) {
        const rates = {
            'flac192': '192 kHz',
            'flac96': '96 kHz',
            'aac': '96 kHz'
        };
        return rates[quality] || '';
    }

    getBitDepth(quality) {
        const depths = {
            'flac192': '24 bit',
            'flac96': '24 bit',
            'aac': ''
        };
        return depths[quality] || '';
    }

    stop() {
        this.stopSSE();
        
        this.state = {
            status: 'stop',
            service: 'motherearthradio'
        };
        this.commandRouter.servicePushState(this.state, 'motherearthradio');
        
        return this.mpdPlugin.stop();
    }

    pause() {
        // For live streams, pause = stop
        return this.stop();
    }

    resume() {
        if (this.currentUri) {
            return this.clearAddPlayTrack({ uri: this.currentUri });
        }
        return libQ.resolve();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BROWSE / NAVIGATION
    // ═══════════════════════════════════════════════════════════════════════════

    addToBrowseSources() {
        const data = {
            name: 'Mother Earth Radio',
            uri: 'motherearthradio',
            plugin_type: 'music_service',
            plugin_name: 'motherearthradio',
            albumart: '/albumart?sourceicon=music_service/motherearthradio/mer-logo-wide-smooth-1x.png'
        };
        this.commandRouter.volumioAddToBrowseSources(data);
    }

    removeFromBrowseSources() {
        this.commandRouter.volumioRemoveToBrowseSources('Mother Earth Radio');
    }

    handleBrowseUri(uri) {
        if (uri === 'motherearthradio') {
            return this.browseRoot();
        }
        return libQ.resolve({ navigation: { lists: [] } });
    }

    browseRoot() {
        const items = [];
        
        for (const [key, channel] of Object.entries(this.channels)) {
            // FLAC 192kHz/24bit (Hi-Res)
            items.push({
                service: 'motherearthradio',
                type: 'song',
                title: `${channel.name} (FLAC 192kHz/24bit)`,
                artist: 'Mother Earth Radio',
                album: 'Hi-Res Lossless',
                uri: `motherearthradio/${key}/flac192`,
                albumart: '/albumart?sourceicon=music_service/motherearthradio/mer-logo-cube-bold-1x 512.png'
            });
            
            // FLAC 96kHz/24bit
            items.push({
                service: 'motherearthradio',
                type: 'song',
                title: `${channel.name} (FLAC 96kHz/24bit)`,
                artist: 'Mother Earth Radio',
                album: 'Lossless',
                uri: `motherearthradio/${key}/flac96`,
                albumart: '/albumart?sourceicon=music_service/motherearthradio/mer-logo-cube-bold-1x 512.png'
            });
            
            // AAC 96kHz
            items.push({
                service: 'motherearthradio',
                type: 'song',
                title: `${channel.name} (AAC 96kHz)`,
                artist: 'Mother Earth Radio',
                album: 'High Quality',
                uri: `motherearthradio/${key}/aac`,
                albumart: '/albumart?sourceicon=music_service/motherearthradio/mer-logo-cube-bold-1x 512.png'
            });
        }

        return libQ.resolve({
            navigation: {
                lists: [{
                    availableListViews: ['list'],
                    items: items
                }],
                prev: { uri: '/' }
            }
        });
    }

    explodeUri(uri) {
        const defer = libQ.defer();
        
        const channelKey = this.getChannelFromUri(uri);
        const quality = this.getQualityFromUri(uri);
        const channel = this.channels[channelKey];
        
        if (!channel) {
            defer.reject('Unknown channel');
            return defer.promise;
        }

        const streamUrl = this.getStreamUrl(channelKey, quality);
        const qualityLabel = this.getQualityLabel(quality);
        
        defer.resolve([{
            service: 'motherearthradio',
            type: 'track',
            trackType: quality.startsWith('flac') ? 'flac' : 'aac',
            radioType: 'motherearthradio',
            title: `${channel.name} (${qualityLabel})`,
            artist: 'Mother Earth Radio',
            album: qualityLabel,
            uri: uri,
            realUri: streamUrl,
            albumart: '/albumart?sourceicon=music_service/motherearthradio/mer-logo-cube-bold-1x 512.png',
            duration: 0,
            samplerate: this.getSampleRate(quality),
            bitdepth: this.getBitDepth(quality)
        }]);
        
        return defer.promise;
    }

    search(query) {
        // Not implemented for radio streams
        return libQ.resolve([]);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION UI
    // ═══════════════════════════════════════════════════════════════════════════

    getUIConfig() {
        const defer = libQ.defer();
        const lang_code = this.commandRouter.sharedVars.get('language_code');
        
        this.commandRouter.i18nJson(
            __dirname + '/i18n/strings_' + lang_code + '.json',
            __dirname + '/i18n/strings_en.json',
            __dirname + '/UIConfig.json'
        )
        .then((uiconf) => {
            // Section 0: Timing Settings
            uiconf.sections[0].content[0].value = this.config.get('highLatencyMode') || false;
            uiconf.sections[0].content[1].value = this.config.get('apiDelay') || 0;
            
            defer.resolve(uiconf);
        })
        .fail((err) => {
            defer.reject(err);
        });
        
        return defer.promise;
    }

    saveConfig(data) {
        const oldHighLatencyMode = this.config.get('highLatencyMode') || false;
        const newHighLatencyMode = data.highLatencyMode || false;
        
        this.config.set('highLatencyMode', newHighLatencyMode);
        this.config.set('apiDelay', data.apiDelay || 0);
        
        this.highLatencyMode = newHighLatencyMode;
        this.metadataDelay = data.apiDelay || 0;
        
        // Apply or restore buffer settings if mode changed
        if (newHighLatencyMode && !oldHighLatencyMode) {
            this.applyHighLatencyBuffer();
            this.showToast('success', 'PLUGIN_NAME', 'HIGH_LATENCY_ENABLED');
        } else if (!newHighLatencyMode && oldHighLatencyMode) {
            this.restoreNormalBuffer();
            this.showToast('success', 'PLUGIN_NAME', 'HIGH_LATENCY_DISABLED');
        } else {
            this.showToast('success', 'PLUGIN_NAME', 'SAVE_CONFIG_MESSAGE');
        }
        
        return libQ.resolve();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HIGH LATENCY MODE
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Apply high latency buffer settings to MPD
     * This helps users with unstable networks (WiFi, bad ISP, long distance)
     */
    applyHighLatencyBuffer() {
        if (!this.mpdPlugin || !this.mpdPlugin.config) {
            this.log('warn', 'Cannot apply buffer settings - MPD plugin not available');
            return false;
        }

        try {
            const currentBuffer = this.mpdPlugin.config.get('audio_buffer_size') || NORMAL_BUFFER_KB;
            
            if (currentBuffer < HIGH_LATENCY_BUFFER_KB) {
                this.mpdPlugin.config.set('audio_buffer_size', HIGH_LATENCY_BUFFER_KB);
                this.log('info', `🔧 High Latency Mode: Buffer increased to ${HIGH_LATENCY_BUFFER_KB} KB`);
                
                // Note: MPD needs restart for buffer changes to take effect
                // Volumio will do this on next playback or reboot
                return true;
            } else {
                this.log('info', `Buffer already >= ${HIGH_LATENCY_BUFFER_KB} KB`);
                return true;
            }
        } catch (err) {
            this.log('error', `Failed to apply buffer settings: ${err.message}`);
            return false;
        }
    }

    /**
     * Restore normal buffer settings
     */
    restoreNormalBuffer() {
        if (!this.mpdPlugin || !this.mpdPlugin.config) {
            return false;
        }

        try {
            this.mpdPlugin.config.set('audio_buffer_size', NORMAL_BUFFER_KB);
            this.log('info', `🔧 Normal Mode: Buffer restored to ${NORMAL_BUFFER_KB} KB`);
            return true;
        } catch (err) {
            this.log('error', `Failed to restore buffer settings: ${err.message}`);
            return false;
        }
    }

    /**
     * Get effective metadata delay (manual + high latency mode)
     */
    getEffectiveDelay() {
        let delay = this.metadataDelay || 0;
        
        if (this.highLatencyMode) {
            delay += HIGH_LATENCY_DELAY_MS;
        }
        
        return Math.max(0, delay);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    getChannelFromUri(uri) {
        if (!uri) return 'radio';
        
        // New format: motherearthradio/channel/quality
        const parts = uri.split('/');
        if (parts[0] === 'motherearthradio' && parts.length >= 2) {
            const channelKey = parts[1];
            if (this.channels[channelKey]) {
                return channelKey;
            }
        }
        
        // Fallback: check by shortcode in URL (for direct stream URLs)
        for (const [key, channel] of Object.entries(this.channels)) {
            if (uri.includes(channel.shortcode)) {
                return key;
            }
        }
        return 'radio';  // Default
    }

    getQualityFromUri(uri) {
        if (!uri) return 'flac192';
        
        // New format: motherearthradio/channel/quality
        const parts = uri.split('/');
        if (parts[0] === 'motherearthradio' && parts.length >= 3) {
            const quality = parts[2];
            if (['flac192', 'flac96', 'aac'].includes(quality)) {
                return quality;
            }
        }
        
        // Fallback: detect from URL
        if (uri.includes('.flac-lo')) return 'flac96';
        if (uri.includes('.aac')) return 'aac';
        return 'flac192';  // Default to highest quality
    }

    getStreamUrl(channelKey, quality) {
        const channel = this.channels[channelKey];
        if (!channel) return null;
        return channel.streams[quality] || channel.streams.flac192;
    }

    loadI18nStrings() {
        try {
            const lang_code = this.commandRouter.sharedVars.get('language_code');
            this.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_' + lang_code + '.json');
        } catch (e) {
            this.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
        }
    }

    getI18nString(key) {
        return this.i18nStrings?.[key] || key;
    }

    showToast(type, title, message) {
        this.commandRouter.pushToastMessage(
            type,
            this.getI18nString(title),
            this.getI18nString(message)
        );
    }

    log(level, message) {
        const prefix = '[MER]';
        switch (level) {
            case 'error':
                this.logger.error(`${prefix} ${message}`);
                break;
            case 'warn':
                this.logger.warn(`${prefix} ${message}`);
                break;
            case 'info':
                this.logger.info(`${prefix} ${message}`);
                break;
            case 'debug':
            default:
                this.logger.info(`${prefix} [DEBUG] ${message}`);
        }
    }

    /**
     * Get diagnostics for troubleshooting
     */
    getDiagnostics() {
        return {
            mode: 'SSE (Server-Sent Events)',
            currentChannel: this.currentChannel,
            currentUri: this.currentUri,
            sseConnected: this.sseRequest !== null,
            sseReconnectAttempts: this.sseReconnectAttempts,
            highLatencyMode: this.highLatencyMode,
            metadataDelay: this.metadataDelay,
            effectiveDelay: this.getEffectiveDelay(),
            bufferSize: this.highLatencyMode ? `${HIGH_LATENCY_BUFFER_KB} KB (High Latency)` : `${NORMAL_BUFFER_KB} KB (Normal)`,
            state: this.state,
            version: '1.4.0'
        };
    }
}

module.exports = MotherEarthRadio;
