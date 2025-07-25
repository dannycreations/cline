import { useClineAuth } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AccountServiceClient } from "@/services/grpc-client"
import { formatCreditsBalance } from "@/utils/format"
import { UsageTransaction as ClineAccountUsageTransaction, PaymentTransaction } from "@shared/ClineAccount"
import { UsageTransaction as ProtoUsageTransaction, UserOrganization, UserOrganizationUpdateRequest } from "@shared/proto/account"
import { EmptyRequest } from "@shared/proto/common"
import {
	VSCodeButton,
	VSCodeDivider,
	VSCodeDropdown,
	VSCodeLink,
	VSCodeOption,
	VSCodeTag,
} from "@vscode/webview-ui-toolkit/react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import ClineLogoWhite from "../../assets/ClineLogoWhite"
import CreditsHistoryTable from "./CreditsHistoryTable"
import VSCodeButtonLink from "../common/VSCodeButtonLink"

// Custom hook for animated credit display with styled decimals
const useAnimatedCredits = (targetValue: number, duration: number = 660) => {
	const [currentValue, setCurrentValue] = useState(0)
	const animationRef = useRef<number>()
	const startTimeRef = useRef<number>()

	useEffect(() => {
		const animate = (timestamp: number) => {
			if (!startTimeRef.current) {
				startTimeRef.current = timestamp
			}

			const elapsed = timestamp - startTimeRef.current
			const progress = Math.min(elapsed / duration, 1)

			// Easing function (ease-out)
			const easedProgress = 1 - (1 - progress) ** 3
			const newValue = easedProgress * targetValue

			setCurrentValue(newValue)

			if (progress < 1) {
				animationRef.current = requestAnimationFrame(animate)
			}
		}

		// Reset and start animation
		startTimeRef.current = undefined
		animationRef.current = requestAnimationFrame(animate)

		return () => {
			if (animationRef.current) {
				cancelAnimationFrame(animationRef.current)
			}
		}
	}, [targetValue, duration])

	return currentValue
}

// Custom component to handle styled credit display
const StyledCreditDisplay = ({ balance }: { balance: number }) => {
	const animatedValue = useAnimatedCredits(formatCreditsBalance(balance))
	const formatted = animatedValue.toFixed(4)
	const parts = formatted.split(".")
	const wholePart = parts[0]
	const decimalPart = parts[1] || "0000"
	const firstTwoDecimals = decimalPart.slice(0, 2)
	const lastTwoDecimals = decimalPart.slice(2)

	return (
		<span className="font-azeret-mono font-light tabular-nums">
			{wholePart}.{firstTwoDecimals}
			<span className="text-[var(--vscode-descriptionForeground)]">{lastTwoDecimals}</span>
		</span>
	)
}

type VSCodeDropdownChangeEvent = Event & {
	target: {
		value: string
	}
}

type AccountViewProps = {
	onDone: () => void
}

const AccountView = ({ onDone }: AccountViewProps) => {
	return (
		<div className="fixed inset-0 flex flex-col overflow-hidden pt-[10px] pl-[20px]">
			<div className="flex justify-between items-center mb-[17px] pr-[17px]">
				<h3 className="text-[var(--vscode-foreground)] m-0">Account</h3>
				<VSCodeButton onClick={onDone}>Done</VSCodeButton>
			</div>
			<div className="flex-grow overflow-hidden pr-[8px] flex flex-col">
				<div className="h-full mb-[5px]">
					<ClineAccountView />
				</div>
			</div>
		</div>
	)
}

const getMainRole = (roles?: string[]) => {
	if (!roles) return undefined

	if (roles.includes("owner")) return "Owner"
	if (roles.includes("admin")) return "Admin"

	return "Member"
}

const CLINE_APP_URL = "https://app.cline.bot"

export const ClineAccountView = () => {
	const { clineUser, handleSignIn, handleSignOut } = useClineAuth()
	const { userInfo, apiConfiguration } = useExtensionState()

	const user = apiConfiguration?.clineAccountId ? clineUser || userInfo : undefined

	const [balance, setBalance] = useState<number | null>(null)
	const [userOrganizations, setUserOrganizations] = useState<UserOrganization[]>([])
	const [activeOrganization, setActiveOrganization] = useState<UserOrganization | null>(null)
	const [isLoading, setIsLoading] = useState(true)
	const [isSwitchingOrg, setIsSwitchingOrg] = useState(false)
	const [usageData, setUsageData] = useState<ClineAccountUsageTransaction[]>([])
	const [paymentsData, setPaymentsData] = useState<PaymentTransaction[]>([])
	const intervalRef = useRef<NodeJS.Timeout | null>(null)

	const clineUris = useMemo(() => {
		const base = new URL(clineUser?.appBaseUrl || CLINE_APP_URL)
		const dashboard = new URL("dashboard", base)
		const credits = new URL(activeOrganization ? "/organization" : "/account", dashboard)
		credits.searchParams.set("tab", "credits")
		credits.searchParams.set("redirect", "true")

		return {
			dashboard,
			credits,
		}
	}, [clineUser?.appBaseUrl, activeOrganization])

	async function getUserCredits() {
		setIsLoading(true)
		try {
			const response = await AccountServiceClient.getUserCredits(EmptyRequest.create())
			setBalance(response.balance?.currentBalance ?? null)
			setUsageData(convertProtoUsageTransactions(response.usageTransactions))
			setPaymentsData(response.paymentTransactions)
		} catch (error) {
			console.error("Failed to fetch user credits data:", error)
			setBalance(null)
			setUsageData([])
			setPaymentsData([])
		} finally {
			setIsLoading(false)
		}
	}

	async function getUserOrganizations() {
		setIsLoading(true)
		try {
			const response = await AccountServiceClient.getUserOrganizations(EmptyRequest.create())
			setUserOrganizations(response.organizations || [])
			setActiveOrganization(response.organizations.find((org: UserOrganization) => org.active) || null)
		} catch (error) {
			console.error("Failed to fetch user organizations:", error)
			setUserOrganizations([])
			setActiveOrganization(null)
		} finally {
			setIsLoading(false)
		}
	}

	// Fetch all account data when component mounts using gRPC
	useEffect(() => {
		if (!user) return

		const fetchUserData = async () => {
			try {
				Promise.all([getUserCredits(), getUserOrganizations()])
			} catch (error) {
				console.error("Failed to fetch user data:", error)
				setBalance(null)
				setUsageData([])
				setPaymentsData([])
			} finally {
				setIsLoading(false)
			}
		}

		fetchUserData()
	}, [user])

	// Periodic refresh while component is mounted
	useEffect(() => {
		if (!user) return

		intervalRef.current = setInterval(() => {
			getUserCredits().catch((err) => console.error("Auto-refresh failed:", err))
		}, 10_000)

		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current)
		}
	}, [user])

	const handleManualRefresh = async () => {
		await getUserCredits()

		if (intervalRef.current) {
			clearInterval(intervalRef.current)
			intervalRef.current = setInterval(() => {
				getUserCredits().catch((err) => console.error("Auto-refresh failed:", err))
			}, 10_000)
		}
	}

	const handleLogin = () => {
		handleSignIn()
	}

	const handleLogout = () => {
		handleSignOut()
	}

	const handleOrganizationChange = useCallback(
		async (event: any) => {
			const newOrgId = (event.target as VSCodeDropdownChangeEvent["target"]).value

			if (activeOrganization?.organizationId !== newOrgId) {
				setIsSwitchingOrg(true) // Disable dropdown

				try {
					await AccountServiceClient.setUserOrganization(
						UserOrganizationUpdateRequest.create({ organizationId: newOrgId }),
					)
					await getUserOrganizations() // Refresh to get new active org
					await getUserCredits() // Refresh credits for new org
				} catch (error) {
					console.error("Failed to update organization:", error)
				} finally {
					setIsSwitchingOrg(false) // Re-enable dropdown
				}
			}
		},
		[activeOrganization],
	)

	return (
		<div className="h-full flex flex-col">
			{user ? (
				<div className="flex flex-col pr-3 h-full">
					<div className="flex flex-col w-full">
						<div className="flex items-center mb-6 flex-wrap gap-y-4">
							{/* {user.photoUrl ? (
								<img src={user.photoUrl} alt="Profile" className="size-16 rounded-full mr-4" />
							) : ( */}
							<div className="size-16 rounded-full bg-[var(--vscode-button-background)] flex items-center justify-center text-2xl text-[var(--vscode-button-foreground)] mr-4">
								{user.displayName?.[0] || user.email?.[0] || "?"}
							</div>
							{/* )} */}

							<div className="flex flex-col">
								{user.displayName && (
									<h2 className="text-[var(--vscode-foreground)] m-0 text-lg font-medium">
										{user.displayName}
									</h2>
								)}

								{user.email && (
									<div className="text-sm text-[var(--vscode-descriptionForeground)]">{user.email}</div>
								)}

								<div className="flex gap-2 items-center mt-1">
									{userOrganizations && (
										<VSCodeDropdown
											key={activeOrganization?.organizationId || "personal"}
											currentValue={activeOrganization?.organizationId || ""}
											onChange={handleOrganizationChange}
											disabled={isSwitchingOrg || isLoading}
											className="w-full">
											<VSCodeOption value="">Personal</VSCodeOption>
											{userOrganizations.map((org: UserOrganization) => (
												<VSCodeOption key={org.organizationId} value={org.organizationId}>
													{org.name}
												</VSCodeOption>
											))}
										</VSCodeDropdown>
									)}
									{activeOrganization?.roles && (
										<VSCodeTag className="text-xs p-2" title="Role">
											{getMainRole(activeOrganization.roles)}
										</VSCodeTag>
									)}
								</div>
							</div>
						</div>
					</div>

					<div className="w-full flex gap-2 flex-col min-[225px]:flex-row">
						<div className="w-full min-[225px]:w-1/2">
							<VSCodeButtonLink href={clineUris.dashboard.href} appearance="primary" className="w-full">
								Dashboard
							</VSCodeButtonLink>
						</div>
						<VSCodeButton appearance="secondary" onClick={handleLogout} className="w-full min-[225px]:w-1/2">
							Log out
						</VSCodeButton>
					</div>

					{/* Credit balance is not available for organization account */}
					{activeOrganization === null && <VSCodeDivider className="w-full my-6" />}

					{activeOrganization === null && (
						<div className="w-full flex flex-col items-center">
							<div className="text-sm text-[var(--vscode-descriptionForeground)] mb-3 font-azeret-mono font-light">
								CURRENT BALANCE
							</div>

							<div className="text-4xl font-bold text-[var(--vscode-foreground)] mb-6 flex items-center gap-2">
								{isLoading ? (
									<div className="text-[var(--vscode-descriptionForeground)]">Loading...</div>
								) : (
									<>
										{balance === null ? (
											<span>----</span>
										) : (
											<>
												<StyledCreditDisplay balance={balance} />
											</>
										)}
										<VSCodeButton appearance="icon" className="mt-1" onClick={handleManualRefresh}>
											<span className="codicon codicon-refresh"></span>
										</VSCodeButton>
									</>
								)}
							</div>

							<div className="w-full">
								<VSCodeButtonLink href={clineUris.credits.href} className="w-full">
									Add Credits
								</VSCodeButtonLink>
							</div>
						</div>
					)}

					<VSCodeDivider className="mt-6 mb-3 w-full" />

					<div className="flex-grow flex flex-col min-h-0 pb-[0px]">
						<CreditsHistoryTable
							isLoading={isLoading}
							usageData={usageData}
							paymentsData={paymentsData}
							showPayments={!activeOrganization}
						/>
					</div>
				</div>
			) : (
				<div className="flex flex-col items-center pr-3">
					<ClineLogoWhite className="size-16 mb-4" />

					<p style={{}}>
						Sign up for an account to get access to the latest models, billing dashboard to view usage and credits,
						and more upcoming features.
					</p>

					<VSCodeButton onClick={handleLogin} className="w-full mb-4">
						Sign up with Cline
					</VSCodeButton>

					<p className="text-[var(--vscode-descriptionForeground)] text-xs text-center m-0">
						By continuing, you agree to the <VSCodeLink href="https://cline.bot/tos">Terms of Service</VSCodeLink> and{" "}
						<VSCodeLink href="https://cline.bot/privacy">Privacy Policy.</VSCodeLink>
					</p>
				</div>
			)}
		</div>
	)
}

/**
 * Converts a protobuf UsageTransaction to a ClineAccount UsageTransaction
 * by adding the missing id and metadata fields
 */
function convertProtoUsageTransaction(protoTransaction: ProtoUsageTransaction): ClineAccountUsageTransaction {
	return {
		...protoTransaction,
		id: protoTransaction.generationId, // Use generationId as the id
		metadata: {
			additionalProp1: "",
			additionalProp2: "",
			additionalProp3: "",
		},
	}
}

/**
 * Converts an array of protobuf UsageTransactions to ClineAccount UsageTransactions
 */
function convertProtoUsageTransactions(protoTransactions: ProtoUsageTransaction[]): ClineAccountUsageTransaction[] {
	return protoTransactions.map(convertProtoUsageTransaction)
}

export default memo(AccountView)
