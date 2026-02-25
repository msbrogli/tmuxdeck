import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAuthStatus } from '../api/httpClient';

export function useAuth() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['auth'],
    queryFn: fetchAuthStatus,
    staleTime: Infinity,
  });

  const invalidateAuth = () => {
    queryClient.invalidateQueries({ queryKey: ['auth'] });
  };

  return {
    isAuthenticated: data?.authenticated ?? false,
    isPinSet: data?.pinSet ?? false,
    isLoading,
    invalidateAuth,
  };
}
