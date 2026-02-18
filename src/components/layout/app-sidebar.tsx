"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Trophy,
  FileText,
  Plus,
  Send,
  Users,
  Settings,
  GitBranch,
  Medal,
  BookOpen,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useCurrentUser } from "@/hooks/use-current-user";
import { UserNav } from "./user-nav";

const iconMap = {
  LayoutDashboard,
  Trophy,
  FileText,
  Plus,
  Send,
  Users,
  Settings,
  GitBranch,
  Medal,
  BookOpen,
} as const;

type IconName = keyof typeof iconMap;

interface NavItem {
  title: string;
  href: string;
  icon: IconName;
}

const commonItems: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: "LayoutDashboard" },
  { title: "Bounties", href: "/bounties", icon: "Trophy" },
  { title: "Leaderboard", href: "/leaderboard", icon: "Medal" },
  { title: "Docs", href: "/docs", icon: "BookOpen" },
];

const workspaceItems: NavItem[] = [
  { title: "My Bounties", href: "/bounties?mine=true", icon: "FileText" },
  { title: "My Submissions", href: "/bounties?submissions=true", icon: "Send" },
  { title: "My Repos", href: "/repos", icon: "GitBranch" },
  { title: "Create Bounty", href: "/bounties/new", icon: "Plus" },
];

const adminItems: NavItem[] = [
  { title: "All Users", href: "/settings", icon: "Users" },
];

export function AppSidebar() {
  const pathname = usePathname();
  const { user, isLoading } = useCurrentUser();

  const roleItems = user?.role === "admin"
    ? [...workspaceItems, ...adminItems]
    : workspaceItems;

  return (
    <Sidebar>
      <SidebarHeader>
        <Link href="/dashboard" className="flex items-center gap-2 px-2 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-primary text-primary-foreground font-display font-bold text-xs">
            arc
          </div>
          <span className="font-display font-semibold text-base tracking-tight">arcagent</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/50">Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {commonItems.map((item) => {
                const Icon = iconMap[item.icon];
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname === item.href}
                      className="text-sm gap-3"
                    >
                      <Link href={item.href}>
                        <Icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {!isLoading && roleItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/50">Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {roleItems.map((item) => {
                  const Icon = iconMap[item.icon];
                  return (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        isActive={pathname.startsWith(item.href.split("?")[0])}
                        className="text-sm gap-3"
                      >
                        <Link href={item.href}>
                          <Icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === "/settings"}
                  className="text-sm gap-3"
                >
                  <Link href="/settings">
                    <Settings className="h-4 w-4" />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <UserNav />
      </SidebarFooter>
    </Sidebar>
  );
}
