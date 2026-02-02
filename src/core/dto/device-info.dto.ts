export interface DeviceInfoDto {
	deviceId?: string;
	userAgent?: string;
	browser?: string;
	browserVersion?: string;
	os?: string;
	osVersion?: string;
	deviceType?: string;
	ipAddress?: string;
	platform?: string;
	isMobile?: boolean;
	isTablet?: boolean;
	isDesktop?: boolean;
	screenResolution?: string;
	language?: string;
	timezone?: string;
}
