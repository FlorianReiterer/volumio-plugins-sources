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

// Service name - must match exactly
const SERVICE_NAME = 'motherearthradio';

class MotherEarthRadio {
    constructor(context) {
        this.context = context;
        this.commandRouter = context.coreCommand;
        this.logger = context.logger;
        this.configManager = context.configManager;
        
        // Service name for Volumio
        this.serviceName = SERVICE_NAME;
        
        // Instance state
        this.state = {};
        this.currentUri = null;
        this.currentChannel = null;
        this.currentQuality = null;
        
        // SSE connection
        this.sseRequest = null;
        this.sseReconnectAttempts = 0;
        this.sseReconnectTimer = null;
        
        // Metadata delay (user-configurable for fine-tuning)
        this.metadataDelay = 0;
        
        // i18n strings
        this.i18nStrings = {};
        this.i18nStringsDefaults = {};
        
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
        
        this.loadRadioI18nStrings();
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
        return libQ.resolve();
    }

    getConfigurationFiles() {
        return ['config.json'];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SSE (SERVER-SENT EVENTS) - Real-time metadata from AzuraCast
    // ═══════════════════════════════════════════════════════════════════════════

    startSSE(channelKey) {
        this.stopSSE();
        
        const channel = this.channels[channelKey];
        if (!channel) {
            this.log('error', `Unknown channel: ${channelKey}`);
            return;
        }
        
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
            this.sseReconnectAttempts = 0;

            let buffer = '';

            response.on('data', (chunk) => {
                buffer += chunk.toString();
                
                const messages = buffer.split('\n\n');
                buffer = messages.pop();
                
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

    handleSSEMessage(message, channelKey) {
        const lines = message.split('\n');
        let data = null;
        
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    data = JSON.parse(line.substring(6));
                } catch (e) {
                    // Ignore parse errors
                }
            }
        }
        
        if (!data) return;
        
        if (data.connect) {
            this.log('debug', 'SSE connect message received');
            if (data.connect.data && Array.isArray(data.connect.data)) {
                for (const item of data.connect.data) {
                    this.processNowPlayingData(item, channelKey);
                }
            }
            return;
        }
        
        this.processNowPlayingData(data, channelKey);
    }

    processNowPlayingData(data, channelKey) {
        const np = data?.pub?.data?.np || data?.np;
        
        if (!np || !np.now_playing) {
            return;
        }

        const song = np.now_playing.song;
        const duration = np.now_playing.duration || 0;
        const elapsed = np.now_playing.elapsed || 0;
        
        if (!song) return;

        this.log('info', `🎵 Track update: ${song.artist} - ${song.title}`);
        
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

    updateMetadata(song, duration, elapsed, np) {
        const channel = this.channels[this.currentChannel];
        if (!channel) return;

        // Determine quality info
        const qualityLabel = this.getQualityLabel(this.currentQuality);
        const samplerate = this.getSampleRate(this.currentQuality);
        const bitdepth = this.getBitDepth(this.currentQuality);

        this.state = {
            status: 'play',
            service: SERVICE_NAME,
            title: song.title || 'Unknown',
            artist: song.artist || channel.name,
            album: song.album || qualityLabel,
            albumart: song.art || '/albumart?sourceicon=music_service/motherearthradio/motherearthlogo.svg',
            uri: this.currentUri,
            trackType: this.currentQuality === 'aac' ? 'aac' : 'flac',
            seek: elapsed * 1000,
            duration: duration,
            samplerate: samplerate,
            bitdepth: bitdepth,
            channels: 2,
            streaming: true,
            isStreaming: true
        };

        this.commandRouter.servicePushState(this.state, SERVICE_NAME);
    }

    scheduleSSEReconnect(sseUrl, channelKey) {
        if (this.sseReconnectAttempts >= SSE_MAX_RECONNECT_ATTEMPTS) {
            this.log('error', `SSE: Max reconnect attempts (${SSE_MAX_RECONNECT_ATTEMPTS}) reached`);
            this.errorToast('ERROR_STREAM_SERVER');
            return;
        }

        this.sseReconnectAttempts++;
        const delay = SSE_RECONNECT_DELAY_MS * this.sseReconnectAttempts;
        
        this.log('info', `SSE: Reconnecting in ${delay}ms (attempt ${this.sseReconnectAttempts})`);
        
        this.sseReconnectTimer = setTimeout(() => {
            this.connectSSE(sseUrl, channelKey);
        }, delay);
    }

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
        const self = this;
        
        // Stop any existing SSE
        this.stopSSE();
        
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
            .then(() => self.mpdPlugin.sendMpdCommand('clear', []))
            .then(() => self.mpdPlugin.sendMpdCommand('add "' + streamUrl + '"', []))
            .then(() => self.mpdPlugin.sendMpdCommand('play', []))
            .then(() => {
                // Set initial state
                const channel = self.channels[self.currentChannel];
                const qualityLabel = self.getQualityLabel(self.currentQuality);
                
                self.state = {
                    status: 'play',
                    service: SERVICE_NAME,
                    title: channel?.name || 'Mother Earth Radio',
                    artist: 'Connecting...',
                    album: qualityLabel,
                    albumart: '/albumart?sourceicon=music_service/motherearthradio/motherearthlogo.svg',
                    uri: track.uri,
                    trackType: self.currentQuality === 'aac' ? 'aac' : 'flac',
                    streaming: true,
                    isStreaming: true,
                    samplerate: self.getSampleRate(self.currentQuality),
                    bitdepth: self.getBitDepth(self.currentQuality),
                    duration: 0,
                    seek: 0
                };
                
                self.commandRouter.servicePushState(self.state, SERVICE_NAME);
                defer.resolve();
            })
            .fail((err) => {
                self.log('error', 'Failed to play track: ' + err);
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
        const self = this;
        
        self.stopSSE();
        
        self.state = {
            status: 'stop',
            service: SERVICE_NAME
        };
        self.commandRouter.servicePushState(self.state, SERVICE_NAME);
        
        return self.mpdPlugin.stop();
    }

    pause() {
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
            plugin_name: SERVICE_NAME,
            albumart: '/albumart?sourceicon=music_service/motherearthradio/motherearthlogo.svg'
        };
        this.commandRouter.volumioAddToBrowseSources(data);
    }

    removeFromBrowseSources() {
        this.commandRouter.volumioRemoveToBrowseSources('Mother Earth Radio');
    }

    handleBrowseUri(uri) {
        if (uri.startsWith('motherearthradio')) {
            return this.browseRoot();
        }
        return libQ.resolve({ navigation: { lists: [] } });
    }

    browseRoot() {
        const self = this;
        const defer = libQ.defer();
        const items = [];
        
        for (const [key, channel] of Object.entries(this.channels)) {
            // FLAC 192kHz/24bit (Hi-Res)
            items.push({
                service: SERVICE_NAME,
                type: 'mywebradio',  // WICHTIG: nicht 'song' sondern 'mywebradio'!
                title: `${channel.name} (FLAC 192kHz/24bit)`,
                artist: 'Mother Earth Radio',
                album: 'Hi-Res Lossless',
                icon: 'fa fa-music',
                uri: `motherearthradio/${key}/flac192`,
                albumart: '/albumart?sourceicon=music_service/motherearthradio/motherearthlogo.svg'
            });
            
            // FLAC 96kHz/24bit
            items.push({
                service: SERVICE_NAME,
                type: 'mywebradio',
                title: `${channel.name} (FLAC 96kHz/24bit)`,
                artist: 'Mother Earth Radio',
                album: 'Lossless',
                icon: 'fa fa-music',
                uri: `motherearthradio/${key}/flac96`,
                albumart: '/albumart?sourceicon=music_service/motherearthradio/motherearthlogo.svg'
            });
            
            // AAC 96kHz
            items.push({
                service: SERVICE_NAME,
                type: 'mywebradio',
                title: `${channel.name} (AAC 96kHz)`,
                artist: 'Mother Earth Radio',
                album: 'High Quality',
                icon: 'fa fa-music',
                uri: `motherearthradio/${key}/aac`,
                albumart: '/albumart?sourceicon=music_service/motherearthradio/motherearthlogo.svg'
            });
        }

        defer.resolve({
            navigation: {
                lists: [{
                    availableListViews: ['list', 'grid'],
                    items: items
                }],
                prev: { uri: '/' }
            }
        });
        
        return defer.promise;
    }

    explodeUri(uri) {
        const self = this;
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
        
        // Return single track for queue
        defer.resolve([{
            service: SERVICE_NAME,
            type: 'track',
            trackType: quality === 'aac' ? 'aac' : 'flac',
            radioType: SERVICE_NAME,
            title: `${channel.name} (${qualityLabel})`,
            name: `${channel.name} (${qualityLabel})`,
            artist: 'Mother Earth Radio',
            album: qualityLabel,
            uri: uri,
            albumart: '/albumart?sourceicon=music_service/motherearthradio/motherearthlogo.svg',
            duration: 0,
            samplerate: this.getSampleRate(quality),
            bitdepth: this.getBitDepth(quality)
        }]);
        
        return defer.promise;
    }

    search(query) {
        return libQ.resolve([]);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION UI
    // ═══════════════════════════════════════════════════════════════════════════

    getUIConfig() {
        const defer = libQ.defer();
        const self = this;
        const lang_code = this.commandRouter.sharedVars.get('language_code');
        
        this.commandRouter.i18nJson(
            __dirname + '/i18n/strings_' + lang_code + '.json',
            __dirname + '/i18n/strings_en.json',
            __dirname + '/UIConfig.json'
        )
        .then((uiconf) => {
            // Section 0: Timing Settings
            uiconf.sections[0].content[0].value = self.config.get('highLatencyMode') || false;
            uiconf.sections[0].content[1].value = self.config.get('apiDelay') || 0;
            
            defer.resolve(uiconf);
        })
        .fail((err) => {
            self.log('error', 'getUIConfig failed: ' + err);
            defer.reject(err);
        });
        
        return defer.promise;
    }

    saveConfig(data) {
        const self = this;
        const oldHighLatencyMode = this.config.get('highLatencyMode') || false;
        const newHighLatencyMode = data.highLatencyMode || false;
        
        this.config.set('highLatencyMode', newHighLatencyMode);
        this.config.set('apiDelay', data.apiDelay || 0);
        
        this.highLatencyMode = newHighLatencyMode;
        this.metadataDelay = data.apiDelay || 0;
        
        if (newHighLatencyMode && !oldHighLatencyMode) {
            this.applyHighLatencyBuffer();
            this.successToast('HIGH_LATENCY_ENABLED');
        } else if (!newHighLatencyMode && oldHighLatencyMode) {
            this.restoreNormalBuffer();
            this.successToast('HIGH_LATENCY_DISABLED');
        } else {
            this.successToast('SAVE_CONFIG_MESSAGE');
        }
        
        return libQ.resolve();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HIGH LATENCY MODE
    // ═══════════════════════════════════════════════════════════════════════════

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
        
        const parts = uri.split('/');
        if (parts[0] === 'motherearthradio' && parts.length >= 2) {
            const channelKey = parts[1];
            if (this.channels[channelKey]) {
                return channelKey;
            }
        }
        
        for (const [key, channel] of Object.entries(this.channels)) {
            if (uri.includes(channel.shortcode)) {
                return key;
            }
        }
        return 'radio';
    }

    getQualityFromUri(uri) {
        if (!uri) return 'flac192';
        
        const parts = uri.split('/');
        if (parts[0] === 'motherearthradio' && parts.length >= 3) {
            const quality = parts[2];
            if (['flac192', 'flac96', 'aac'].includes(quality)) {
                return quality;
            }
        }
        
        if (uri.includes('.flac-lo')) return 'flac96';
        if (uri.includes('.aac')) return 'aac';
        return 'flac192';
    }

    getStreamUrl(channelKey, quality) {
        const channel = this.channels[channelKey];
        if (!channel) return null;
        return channel.streams[quality] || channel.streams.flac192;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // I18N - Internationalization (matches original plugin pattern)
    // ═══════════════════════════════════════════════════════════════════════════

    loadRadioI18nStrings() {
        const self = this;
        
        try {
            const lang_code = this.commandRouter.sharedVars.get('language_code');
            self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_' + lang_code + '.json');
        } catch (e) {
            self.i18nStrings = {};
        }
        
        // Always load defaults
        try {
            self.i18nStringsDefaults = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
        } catch (e) {
            self.i18nStringsDefaults = {};
        }
    }

    getRadioI18nString(key) {
        if (this.i18nStrings[key] !== undefined) {
            return this.i18nStrings[key];
        }
        if (this.i18nStringsDefaults[key] !== undefined) {
            return this.i18nStringsDefaults[key];
        }
        return key;
    }

    // Toast messages
    successToast(messageKey) {
        this.commandRouter.pushToastMessage(
            'success',
            this.getRadioI18nString('PLUGIN_NAME'),
            this.getRadioI18nString(messageKey)
        );
    }

    errorToast(messageKey) {
        this.commandRouter.pushToastMessage(
            'error',
            this.getRadioI18nString('PLUGIN_NAME'),
            this.getRadioI18nString(messageKey)
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

    getDiagnostics() {
        return {
            mode: 'SSE (Server-Sent Events)',
            currentChannel: this.currentChannel,
            currentQuality: this.currentQuality,
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
